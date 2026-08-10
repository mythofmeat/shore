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
RUN pacman --noconfirm -Syu
COPY --from=build /src/contrib/arch/*.pkg.tar.zst /tmp/pkg/
RUN pacman --noconfirm --needed -U /tmp/pkg/shore-daemon-*
RUN pacman --noconfirm --needed -U /tmp/pkg/shore-cli-*
RUN pacman --noconfirm --needed -U /tmp/pkg/shore-tui-*
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
