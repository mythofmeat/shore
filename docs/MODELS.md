# Models

See [NanoGPT models](NANOGPT.md) for gateway transport and image support,
and [cache keepalive](CACHE_KEEPALIVE.md) for caching settings and costs.

## Claude Agent SDK models

Configure the SDK as a provider in `config.toml` or an included TOML file:

```toml
[providers.claude_agent]

[providers.claude_agent.discovery]
enabled = true

[defaults]
model = "claude_agent:sonnet"
```

Shore uses the same Claude Code login as chat generation. No `api_key_env` or
`base_url` is required. See [Docker authentication](DOCKER.md) for sharing the
login with a container.

Discovery runs on startup and refreshes stale model lists automatically. It
uses the SDK's `supportedModels()` and closes the process without sending a
chat message or saving a conversation. The SDK's choices appear in Shore's
model picker, with its reported reasoning effort capabilities. To refresh or
select a model manually:

```sh
shore provider refresh claude_agent
shore model use claude_agent:sonnet
```

SDK aliases such as `sonnet` follow Claude Code's current model selection. An
explicit model ID also works, including IDs absent from discovery. Favorite
it to keep it in the picker:

```sh
shore model use claude_agent:claude-opus-4-8
shore model fav claude_agent:claude-opus-4-8
shore model setting reasoning_effort high --model claude_agent:claude-opus-4-8 --global
```

To migrate `[chat.*]` entries, replace each old model reference with
`claude_agent:<model_id>`, using that entry's `model_id` value. Move settings
shared by all models to `[providers.claude_agent.defaults]`, and save settings
for individual models with `shore model setting --global` to retain their
scope across characters. Remove the old `[chat.*]` entries once their
references have been updated.

For example:

```toml
[providers.claude_agent.defaults]
reasoning_effort = "high"
```

Provider names are customizable. For `[providers.my_claude]`, add
`sdk = "claude_agent"` and select `my_claude:<model_id>` instead. Discovery is
optional when selecting an explicit ID; set `[defaults].model` to that
qualified name and optionally favorite it.
