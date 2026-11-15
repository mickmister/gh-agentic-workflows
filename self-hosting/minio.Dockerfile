FROM golang:1.25.0-bookworm@sha256:81dc45d05a7444ead8c92a389621fafabc8e40f8fd1a19d7e5df14e61e98bc1a AS build
# Official image distribution is unavailable. Build the previously tested exact
# upstream source; retain its AGPL license and corresponding source in the image.
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
RUN git clone https://github.com/minio/minio.git /src && git -C /src checkout "$MINIO_COMMIT" && test "$(git -C /src rev-parse HEAD)" = "$MINIO_COMMIT"
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -o /minio . && git archive HEAD | gzip > /minio-source.tar.gz
FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c
COPY --from=build /minio /usr/local/bin/minio
COPY --from=build /src/LICENSE /usr/share/doc/minio/LICENSE
COPY --from=build /minio-source.tar.gz /usr/share/doc/minio/source.tar.gz
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
