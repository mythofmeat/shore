FROM archlinux:base-devel AS build

RUN pacman -Syu --noconfirm rust bun git
RUN useradd --create-home builder
RUN install -d -o builder -g builder /src

WORKDIR /src
COPY --chown=builder:builder . .

USER builder
WORKDIR /src/contrib/arch
RUN makepkg --noconfirm

FROM scratch AS artifacts
COPY --from=build /src/contrib/arch/*.pkg.tar.zst /
