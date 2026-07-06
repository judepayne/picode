# picode

A homage to OpenCode in Pi.

GitHub: https://github.com/judepayne/picode

A Pi package for disciplined, role-based coding workflows with mode switching, permissions, subagents, and prompt vars.

![picode preview](https://raw.githubusercontent.com/judepayne/picode/main/img/picode-preview.png)

## Install

```bash
pi install npm:@judepayne/picode
```

Then reload Pi:

```text
/reload
```

Bootstrap prompt-vars files in your project:

```text
/vars bootstrap
```

(this sets up the project specific locations for the design and plan files to enable smooth transition from Designer, Planner and Builder modes)

## What it adds

- **Builder, Planner, and Designer** runtime modes with their own prompts, tools, permission profiles, and style.
- **Scout, worker, and reviewer** subagents for delegated reconnaissance, implementation, and review.
- **An OpenCode inspired permission system** for each agent/subagent, with optional local `/gate auto on` approval for `ask` decisions. Auto approval starts only when explicitly enabled for the session unless the project opts into `gate.auto.startOnSession=true`; users own the local `llama-server` and GGUF model artifacts.
- **Prompt vars** such as `${plan.path}` and `${design.path}` for project-aware agent instructions.
- **Custom markdown cards** so you can override or add your own agents and subagents.

## Basic use

Switch agents with `Ctrl + ,` and `Ctrl + .`, or use the `/agents` command in Pi.

Generally the Builder, Planner, and Designer agents dispatch subagents as they need to, but you can also dispatch subagents directly when useful. Subagents can run synchronously or asynchronously:

```text
~scout inspect this area and report back
~reviewer review the current diff
```

## Customisation

Point picode at your own agent/subagent card directories in `.pi/settings.json`:

```json
{
  "picode": {
    "agentsDir": "./custom-agents",
    "subagentsDir": "./custom-subagents"
  }
}
```

Same-filename overlay cards partially override built-in cards, so you can change one setting without copying the whole prompt.

## Links

- GitHub: https://github.com/judepayne/picode
- Issues: https://github.com/judepayne/picode/issues
- License: MIT
