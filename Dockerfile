FROM archlinux:latest AS builder
RUN pacman --noconfirm -Syu --needed base-devel sudo
RUN useradd -m builduser && \
    passwd -d builduser && \
    echo "builduser ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers
WORKDIR /src
COPY . .
WORKDIR /src/contrib/arch
RUN mkdir /pkg
RUN chown -R builduser /pkg
RUN chown -R builduser /src/contrib/arch
RUN sudo -u builduser PKGDEST=/pkg makepkg -s --noconfirm
FROM archlinux:latest AS entry
RUN pacman -Syu --noconfirm \
    git \
    bun
WORKDIR /pkg
COPY --from=builder /pkg .
RUN pacman -U --noconfirm ./*.pkg.tar.zst
RUN groupadd --gid 1000 shore \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash shore
RUN mkdir -p /shared
RUN pacman -Syu --noconfirm yazi
RUN pacman -Syu --noconfirm neovim \
    fd \
    ripgrep \
    fzf \
    tree-sitter-cli \
    python \
    unzip
RUN mkdir -p /home/shore/.config/nvim \
    /home/shore/.local/share/nvim
ENV EDITOR=nvim
ENV HOME=/home/shore
ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache
ENV SHORE_WORKSPACE_DIR=/workspace
ENV SHORE_ADDR=0.0.0.0:7320
EXPOSE 7320
USER shore
WORKDIR /shared
CMD ["shore-daemon"]
