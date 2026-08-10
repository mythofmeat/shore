FROM archlinux:latest
RUN pacman --noconfirm -Syu \
    github-cli \
    neovim fd ripgrep fzf tree-sitter-cli python unzip \
    yazi

WORKDIR /tmp/pkg
RUN --mount=type=secret,id=gh_auth,env=GH_TOKEN gh release -R mythofmeat/shore download -p \
    shore-*x86_64.pkg.tar.zst
RUN pacman -U --noconfirm ./shore*.pkg.tar.zst

# RUN --mount=type=secret,id=gh_auth,env=GH_TOKEN gh release -R mythofmeat/shore download -p \
#     shore-tui-*x86_64.pkg.tar.zst
# RUN pacman -U --noconfirm ./shore-tui-*.pkg.tar.zst
# RUN --mount=type=secret,id=gh_auth,env=GH_TOKEN gh release -R mythofmeat/shore download -p \
#     shore-daemon-*x86_64.pkg.tar.zst
# RUN pacman -U --noconfirm ./shore-daemon-*.pkg.tar.zst

RUN rm -rf /tmp/pkg

RUN groupadd --gid 1000 shore && \
    useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash shore && \
    chown -R 1000:1000 /home/shore

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
