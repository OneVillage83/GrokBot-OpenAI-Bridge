import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
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
} from '../../core/types.js';
import { redact } from '../../logging/redact.js';
export class SQLiteStore {
  db: DatabaseSync;
  private txDepth = 0;
  constructor(public path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > 1) {
      this.db.close();
      throw new BridgeError(
        'UNSUPPORTED_STATE_VERSION',
        'Use the bridge version that created this database.',
      );
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(project_id) WHERE state NOT IN ('COMPLETED','FAILED');
      CREATE TABLE IF NOT EXISTS chatgpt_turns(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_turns(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), turn_id TEXT, kind TEXT NOT NULL, raw TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, run_id TEXT, turn_id TEXT, timestamp TEXT NOT NULL, component TEXT NOT NULL, event TEXT NOT NULL, status TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks(project_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL);
      PRAGMA user_version=1;`);
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
