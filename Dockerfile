FROM archlinux:base-devel AS build
RUN pacman -Syu --noconfirm rust bun git
RUN useradd --create-home builder
RUN install -d -o builder -g builder /src

WORKDIR /src
COPY --chown=builder:builder . .

USER builder
WORKDIR /src/contrib/arch
RUN makepkg --noconfirm

FROM archlinux:latest
ARG PKGEXT="-0-1-x86_64.pkg.tar.zst"
ARG SHORE_DAEMON_PKG="shore-daemon-${PKGEXT}"
ARG SHORE_CLI_PKG="shore-cli-${PKGEXT}"
ARG SHORE_TUI_PKG="shore-tui-${PKGEXT}"

RUN pacman --noconfirm -Syu

WORKDIR /tmp/pkg
COPY --from=build /src/contrib/arch/${SHORE_DAEMON_PKG} .
RUN pacman --noconfirm --needed -U ${SHORE_DAEMON_PKG}

COPY --from=build /src/contrib/arch/${SHORE_CLI_PKG} .
RUN pacman --noconfirm --needed -U ${SHORE_CLI_PKG}

COPY --from=build /src/contrib/arch/${SHORE_TUI_PKG} .
RUN pacman --noconfirm --needed -U ${SHORE_TUI_PKG}
RUN rm -rf /tmp/pkg

RUN groupadd --gid 1000 shore
RUN useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash shore
RUN chown -R 1000:1000 /home/shore

RUN pacman --noconfirm --needed -S neovim fd ripgrep fzf tree-sitter-cli python unzip
RUN pacman --noconfirm --needed -S    yazi

USER shore
ENV EDITOR=nvim
ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache
ENV SHORE_WORKSPACE_DIR=/workspace
ENV SHORE_ADDR=0.0.0.0:7320
ENV HOME=/home/shore
EXPOSE 7320
WORKDIR /shared
CMD ["shore-daemon"]
