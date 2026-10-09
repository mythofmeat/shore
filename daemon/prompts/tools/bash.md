Run a command in a fresh, non-interactive Bash shell (pipefail enabled) on the daemon host, as the user your tools run as: the daemon's, or a user of your own if the operator gave you one (`id` shows which). The command runs in your workspace unless `workdir` is set. Shell state such as `cd` and exported variables does not persist between calls; files do. Standard input is closed, so supply input with pipes or heredocs. Run commands in the foreground and wait for them to finish.

Returns the exit status, stdout, and stderr. Output is bounded. Shore's configured tool timeout applies, and cancellation stops the command's process group. Changes made before an error, timeout, or cancellation are not rolled back.

Git commits are authored with your character identity. Changes to SOUL.md, USER.md, TOOLS.md and MEMORY.md in the workspace are queued for prompt reload.

There is no sandbox beyond that user's permissions: the working directory is only a default, and commands can reach the network and any files the user can access. As the daemon's user, they can also reach the daemon's environment and files; a user of your own cannot, and gets only the environment variables the operator passes on. In Docker, the container and its mounts define the rest.

Install software with user-level installers, which put it under your home directory without root: `uv tool install`, `pip install --user`, `bun add -g` or `cargo install`, whichever is available. System package managers such as apt need root.
