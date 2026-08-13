FROM alpine:edge AS build

ARG VERSION
ARG PACKAGE_VERSION

RUN apk add --no-cache alpine-sdk cargo git libstdc++ libgcc unzip curl doas && \
    curl -fsSL https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64-musl.zip -o /tmp/bun.zip && \
    unzip -q -j /tmp/bun.zip -d /usr/local/bin && \
    chmod +x /usr/local/bin/bun && \
    rm /tmp/bun.zip

RUN adduser -D builder && \
    addgroup builder abuild && \
    echo 'permit nopass builder' > /etc/doas.d/doas.conf && \
    echo 'REPODEST=/packages' >> /etc/abuild.conf && \
    install -d -o builder -g builder /packages /src

WORKDIR /src
COPY --chown=builder:builder . .

RUN test -n "$VERSION" && \
    test -n "$PACKAGE_VERSION" && \
    sed -i "s/^version = \"0.0.0\"/version = \"$VERSION\"/" client/Cargo.toml && \
    sed -i "s/^pkgver=.*/pkgver=$PACKAGE_VERSION/" contrib/alpine/APKBUILD

USER builder
WORKDIR /src/contrib/alpine
RUN abuild-keygen -ain && abuild -r

FROM scratch AS artifacts
COPY --from=build /packages/*/x86_64/*.apk /
