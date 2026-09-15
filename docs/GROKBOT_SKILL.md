# Installing / teaching the skill

The reusable entrypoint is `skills/grokbot-openai-bridge/SKILL.md`, titled **GrokBot OpenAI Bridge**. Give GrokBot the file and this bridge checkout, then say:

> Save the supplied instructions as a skill called GrokBot OpenAI Bridge. The CLI is installed on your computer. Use project daily-line. Coordinate through its exact existing ChatGPT conversation and its durable Codex thread. Begin with the controlled one-turn test and show me the complete evidence before enabling additional turns.

The official [Grok Bot skills documentation](https://docs.x.ai/grok-bot/skills-routines-and-automations) describes saving written workflows as skills and enabling them per Bot under Settings → Plugins → Yours. Use that supported teaching flow; desktop UI labels may vary.

The [Grok Build skill format](https://docs.x.ai/build/features/skills-plugins-marketplaces) supports folders with `SKILL.md` YAML frontmatter. This entrypoint uses that compatible format. **Grok Build filesystem discovery is not claimed to be a Grok Bot private-plugin upload API.** The Grok Bot page inspected did not specify an archive manifest or upload protocol, so this deliverable does not invent one.

For a host actually running Grok Build, copy the skill folder into `.grok/skills/` in its bridge checkout or `~/.grok/skills/`. For Grok Bot, provide the file through its normal attachment/filesystem tools and ask it to save the skill. Keep the bridge documentation accessible at its installed checkout path.

Installation does not authenticate ChatGPT/Codex or grant external permissions. Tell GrokBot where its CLI and state directory are installed and have the user complete login takeover before the first live test.
