import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { assertTransition } from '../../core/state-machine.js';
import {
  BridgeError,
  now,
  type Project,
  type Run,
  type State,
  type ChatTurn,
  type CodexTurn,
  type ProjectRepository,
  type CodexWorkstream,
  type ProjectRegistration,
} from '../../core/types.js';
import { identifier, pathsOverlap } from '../../config/project.js';
import { redact } from '../../logging/redact.js';
export class SQLiteStore {
  db: DatabaseSync;
  private txDepth = 0;
  readonly rawRoot: string;
  migrationBackup?: string;
  constructor(
    public path: string,
    options: { migrate?: boolean } = {},
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > 2 || (version === 1 && !options.migrate)) {
      this.db.close();
      throw new BridgeError(
        version > 2 ? 'UNSUPPORTED_STATE_VERSION' : 'STATE_MIGRATION_REQUIRED',
        version > 2
          ? 'Use the bridge version that created this database.'
          : 'Stop bridge controllers, then run bridge migrate to back up and upgrade schema 1 to 2.',
      );
    }
    this.rawRoot =
      path === ':memory:'
        ? mkdtempSync(join(tmpdir(), 'bridge-artifacts-'))
        : join(dirname(path), 'artifacts');
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (version === 1) {
      if (this.db.prepare('SELECT COUNT(*) AS n FROM locks').get()?.n) {
        this.db.close();
        throw new BridgeError(
          'MIGRATION_LOCKED',
          'Stop all bridge controllers and release existing project locks before migration.',
        );
      }
      this.migrationBackup = path + `.v1-backup-${randomUUID()}.sqlite`;
      this.db.prepare('VACUUM INTO ?').run(this.migrationBackup);
    }
    this.tx(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(project_id) WHERE state NOT IN ('COMPLETED','FAILED');
      CREATE TABLE IF NOT EXISTS chatgpt_turns(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_turns(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), turn_id TEXT, kind TEXT NOT NULL, raw TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, run_id TEXT, turn_id TEXT, timestamp TEXT NOT NULL, component TEXT NOT NULL, event TEXT NOT NULL, status TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks(project_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_repositories(project_id TEXT NOT NULL REFERENCES projects(id), repository_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id,repository_id));
      CREATE TABLE IF NOT EXISTS codex_workstreams(project_id TEXT NOT NULL, workstream_id TEXT NOT NULL, repository_id TEXT NOT NULL, codex_thread_id TEXT UNIQUE, data TEXT NOT NULL, PRIMARY KEY(project_id,workstream_id), FOREIGN KEY(project_id,repository_id) REFERENCES project_repositories(project_id,repository_id));`);
      if (version === 1) this.migrateLegacy();
      this.db.exec('PRAGMA user_version=2;');
    });
  }
  private migrateLegacy() {
    for (const row of this.db.prepare('SELECT data FROM projects').all()) {
      const old = JSON.parse(row.data as string);
      const { repo_url, repo_path, working_branch, codex_thread_id, ...project } = old;
      project.autonomy_enabled = false;
      project.smoke_passed = false;
      this.saveProject(project);
      const repo: ProjectRepository = {
        project_id: old.project_id,
        repository_id: 'primary',
        logical_name: 'Migrated primary repository',
        repo_url,
        repo_path,
        default_branch: '',
        working_branch,
        role: 'Migrated v1 repository; configure default_branch before use',
        enabled: true,
      };
      this.db
        .prepare('INSERT INTO project_repositories VALUES(?,?,?)')
        .run(old.project_id, 'primary', JSON.stringify(repo));
      this.saveWorkstream({
        project_id: old.project_id,
        workstream_id: 'primary',
        repository_id: 'primary',
        codex_thread_id: codex_thread_id ?? null,
        current_task: old.current_task ?? '',
        status: 'PAUSED',
      });
      for (const record of this.history(old.project_id)) {
        const { baseline_head, ...rest } = record;
        const active = !['COMPLETED', 'FAILED'].includes(record.state);
        const r: Run = {
          ...rest,
          repository_baselines: { primary: baseline_head },
          authorized_repository_ids: ['primary'],
          pending_repository_ids: record.pending_instruction ? ['primary'] : [],
          pending_workstream_id: record.pending_instruction ? 'primary' : null,
          migration_review_required: active,
        };
        if (active) {
          r.state = 'WAITING_FOR_USER';
          r.reason =
            'MIGRATION_REVIEW_REQUIRED: reconcile v1 external work, then cancel this run and start a routed v2 run.';
          project.run_status = r.state;
          this.saveProject(project);
        }
        this.saveRun(r);
        this.event(r, 'storage', 'schema-migrated', {
          from: 1,
          to: 2,
          previous_state: record.state,
        });
        for (const turn of this.codexTurns(r.id))
          this.saveCodex({ ...turn, repository_id: 'primary', workstream_id: 'primary' });
      }
    }
  }
  repositories(projectId?: string): ProjectRepository[] {
    return this.db
      .prepare(
        `SELECT data FROM project_repositories ${projectId ? 'WHERE project_id=?' : ''} ORDER BY project_id,repository_id`,
      )
      .all(...(projectId ? [projectId] : []))
      .map((x) => JSON.parse(x.data as string));
  }
  repository(projectId: string, id: string): ProjectRepository {
    const row = this.db
      .prepare('SELECT data FROM project_repositories WHERE project_id=? AND repository_id=?')
      .get(projectId, id);
    if (!row) throw new BridgeError('UNAUTHORIZED_REPOSITORY', id);
    return JSON.parse(row.data as string);
  }
  workstreams(projectId: string): CodexWorkstream[] {
    return this.db
      .prepare('SELECT data FROM codex_workstreams WHERE project_id=? ORDER BY workstream_id')
      .all(projectId)
      .map((x) => JSON.parse(x.data as string));
  }
  workstream(projectId: string, id: string): CodexWorkstream {
    const row = this.db
      .prepare('SELECT data FROM codex_workstreams WHERE project_id=? AND workstream_id=?')
      .get(projectId, id);
    if (!row) throw new BridgeError('UNKNOWN_WORKSTREAM', id);
    return JSON.parse(row.data as string);
  }
  saveWorkstream(w: CodexWorkstream) {
    const existing = this.workstreams(w.project_id).find(
      (x) => x.workstream_id === w.workstream_id,
    );
    if (
      existing &&
      (existing.repository_id !== w.repository_id ||
        (existing.codex_thread_id && existing.codex_thread_id !== w.codex_thread_id))
    )
      throw new BridgeError('WORKSTREAM_IDENTITY_CHANGE');
    this.db
      .prepare(
        'INSERT INTO codex_workstreams VALUES(?,?,?,?,?) ON CONFLICT(project_id,workstream_id) DO UPDATE SET codex_thread_id=excluded.codex_thread_id,data=excluded.data',
      )
      .run(w.project_id, w.workstream_id, w.repository_id, w.codex_thread_id, JSON.stringify(w));
  }
  private assertRegistryIdle(projectId: string) {
    const r = this.latest(projectId);
    if (r && !['COMPLETED', 'FAILED'].includes(r.state))
      throw new BridgeError(
        'ACTIVE_RUN_EXISTS',
        'Registry changes require a stopped, reconciled run.',
      );
  }
  addRepository(repo: ProjectRepository) {
    this.assertRegistryIdle(repo.project_id);
    this.project(repo.project_id);
    for (const existing of this.repositories())
      if (pathsOverlap(existing.repo_path, repo.repo_path))
        throw new BridgeError(
          'REPOSITORY_PATH_OVERLAP',
          'Repositories require separate non-overlapping canonical checkouts.',
        );
    if (this.path !== ':memory:' && pathsOverlap(repo.repo_path, dirname(this.path)))
      throw new BridgeError(
        'STATE_REPOSITORY_OVERLAP',
        'Keep the private state directory outside repository roots.',
      );
    this.db
      .prepare('INSERT INTO project_repositories VALUES(?,?,?)')
      .run(repo.project_id, repo.repository_id, JSON.stringify(repo));
  }
  addWorkstream(w: CodexWorkstream) {
    this.assertRegistryIdle(w.project_id);
    this.repository(w.project_id, w.repository_id);
    if (this.workstreams(w.project_id).some((x) => x.workstream_id === w.workstream_id))
      throw new BridgeError('WORKSTREAM_EXISTS');
    this.saveWorkstream(w);
  }
  updateRepository(repo: ProjectRepository) {
    this.assertRegistryIdle(repo.project_id);
    const old = this.repository(repo.project_id, repo.repository_id);
    if (
      old.repo_path !== repo.repo_path ||
      old.repo_url !== repo.repo_url ||
      old.working_branch !== repo.working_branch
    )
      throw new BridgeError(
        'REPOSITORY_IDENTITY_CHANGE',
        'Use a new repository/workstream identity for a different checkout, origin or working branch.',
      );
    this.db
      .prepare('UPDATE project_repositories SET data=? WHERE project_id=? AND repository_id=?')
      .run(JSON.stringify(repo), repo.project_id, repo.repository_id);
  }
  register(registration: ProjectRegistration) {
    this.tx(() => {
      const { project, repositories, workstreams } = registration;
      if (this.projects().some((x) => x.project_id === project.project_id))
        throw new BridgeError('PROJECT_EXISTS');
      this.saveProject(project);
      for (const repo of repositories) this.addRepository(repo);
      for (const w of workstreams) this.addWorkstream(w);
    });
  }
  evidenceDirectory(r: Run, turnId: string, repositoryId: string) {
    for (const id of [r.id, turnId, repositoryId]) identifier(id);
    const path = join(this.rawRoot, r.id, turnId, repositoryId, randomUUID());
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }
  tx<T>(f: () => T): T {
    if (this.txDepth) return f();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const v = f();
      this.db.exec('COMMIT');
      return v;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.txDepth--;
    }
  }
  project(id: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id);
    if (!row) throw new BridgeError('PROJECT_NOT_FOUND', id);
    return JSON.parse(row.data as string);
  }
  projects(): Project[] {
    return this.db
      .prepare('SELECT data FROM projects ORDER BY id')
      .all()
      .map((x) => JSON.parse(x.data as string));
  }
  saveProject(p: Project) {
    p.updated_at = now();
    this.db
      .prepare('INSERT INTO projects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(p.project_id, JSON.stringify(p));
  }
  run(id: string): Run {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id);
    if (!row) throw new BridgeError('RUN_NOT_FOUND');
    return JSON.parse(row.data as string);
  }
  latest(project: string): Run | undefined {
    const row = this.db
      .prepare('SELECT data FROM runs WHERE project_id=? ORDER BY rowid DESC LIMIT 1')
      .get(project);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  saveRun(r: Run) {
    r.updated_at = now();
    this.db
      .prepare(
        'INSERT INTO runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data',
      )
      .run(r.id, r.project_id, r.state, JSON.stringify(r));
  }
  transition(r: Run, state: State, reason = '') {
    assertTransition(r.state, state);
    const from = r.state;
    this.tx(() => {
      const current = this.run(r.id);
      if (current.state === 'PAUSED' && r.state !== 'PAUSED' && state !== 'PAUSED')
        throw new BridgeError('USER_PAUSED');
      r.state = state;
      r.reason = reason;
      this.saveRun(r);
      const p = this.project(r.project_id);
      p.run_status = state;
      p.current_task = r.task;
      this.saveProject(p);
      this.event(r, 'orchestrator', 'transition', { from, to: state, reason });
    });
  }
  chat(id: string): ChatTurn {
    const row = this.db.prepare('SELECT data FROM chatgpt_turns WHERE id=?').get(id);
    if (!row) throw new BridgeError('CHATGPT_TURN_NOT_FOUND');
    return JSON.parse(row.data as string);
  }
  saveChat(t: ChatTurn) {
    this.db
      .prepare(
        'INSERT INTO chatgpt_turns VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(t.id, t.run_id, JSON.stringify(t));
  }
  codex(id: string): CodexTurn {
    const row = this.db.prepare('SELECT data FROM codex_turns WHERE id=?').get(id);
    if (!row) throw new BridgeError('CODEX_TURN_NOT_FOUND');
    return JSON.parse(row.data as string);
  }
  saveCodex(t: CodexTurn) {
    this.db
      .prepare(
        'INSERT INTO codex_turns VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(t.id, t.run_id, JSON.stringify(t));
  }
  codexTurns(run: string): CodexTurn[] {
    return this.db
      .prepare('SELECT data FROM codex_turns WHERE run_id=? ORDER BY rowid')
      .all(run)
      .map((x) => JSON.parse(x.data as string));
  }
  responseSeen(project: string, response: string) {
    return this.db
      .prepare('SELECT data FROM chatgpt_turns')
      .all()
      .map((x) => JSON.parse(x.data as string) as ChatTurn)
      .some((x) => x.project_id === project && x.response_id === response);
  }
  artifact(r: Run, kind: string, raw: unknown, turnId: string | null = null) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?)')
      .run(id, r.id, turnId, kind, typeof raw === 'string' ? raw : JSON.stringify(raw), now());
    return id;
  }
  approval(r: Run, data: unknown) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO approvals VALUES(?,?,?)')
      .run(id, r.id, JSON.stringify({ timestamp: now(), ...(data as object) }));
    return id;
  }
  event(
    r: Run | null,
    component: string,
    event: string,
    data: unknown = {},
    turnId: string | null = null,
  ) {
    this.db
      .prepare(
        'INSERT INTO events(project_id,run_id,turn_id,timestamp,component,event,status,data) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        r?.project_id ?? null,
        r?.id ?? null,
        turnId,
        now(),
        component,
        event,
        r?.state ?? null,
        JSON.stringify(redact(data)),
      );
  }
  history(project: string) {
    return this.db
      .prepare('SELECT data FROM runs WHERE project_id=? ORDER BY rowid')
      .all(project)
      .map((x) => JSON.parse(x.data as string));
  }
  logs(run?: string): Array<Record<string, any>> {
    return this.db
      .prepare(`SELECT * FROM events ${run ? 'WHERE run_id=?' : ''} ORDER BY seq`)
      .all(...(run ? [run] : []))
      .map((x) => ({ ...x, data: JSON.parse(x.data as string) }));
  }
  artifacts(run: string) {
    return this.db.prepare('SELECT * FROM artifacts WHERE run_id=? ORDER BY rowid').all(run);
  }
  lock(project: string) {
    const owner = randomUUID();
    this.tx(() => {
      const l = this.db.prepare('SELECT * FROM locks WHERE project_id=?').get(project);
      if (l) {
        let alive = true;
        if (l.host === hostname()) {
          try {
            process.kill(Number(l.pid), 0);
          } catch (e: any) {
            if (e.code === 'ESRCH') alive = false;
          }
        }
        if (alive)
          throw new BridgeError('PROJECT_BUSY', 'Another process holds this project lock.');
        this.db.prepare('DELETE FROM locks WHERE project_id=?').run(project);
      }
      this.db
        .prepare('INSERT INTO locks VALUES(?,?,?,?)')
        .run(project, owner, process.pid, hostname());
    });
    return () =>
      this.db.prepare('DELETE FROM locks WHERE project_id=? AND owner=?').run(project, owner);
  }
  close() {
    this.db.close();
  }
}
