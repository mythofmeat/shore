FROM archlinux:base-devel AS builder
RUN pacman --noconfirm -Syu
COPY . /src
RUN pacman --noconfirm -S sudo

RUN useradd -m builduser
RUN passwd -d builduser
RUN chown -R builduser:builduser /src
RUN echo "builduser ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

USER builduser
RUN makepkg -D /src/contrib/arch -s --noconfirm --nocheck

FROM archlinux:latest AS entry
RUN pacman --noconfirm -Syu
# \
#    git \
#    bun
WORKDIR /pkg
COPY --from=builder /src/contrib/arch/*.pkg.tar.zst .
RUN pacman -U --noconfirm ./*.pkg.tar.zst

RUN groupadd --gid 1000 shore && \
    useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash shore && \
    chown -R 1000:1000 /home/shore
ENV HOME=/home/shore

RUN pacman --noconfirm -S git
RUN pacman --noconfirm -S bun
RUN pacman --noconfirm -S yazi

RUN pacman --noconfirm -S neovim fd ripgrep fzf tree-sitter-cli python unzip

ENV EDITOR=nvim
ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache
ENV SHORE_WORKSPACE_DIR=/workspace
ENV SHORE_ADDR=0.0.0.0:7320
EXPOSE 7320
USER shore
WORKDIR /shared
CMD ["shore-daemon"]
