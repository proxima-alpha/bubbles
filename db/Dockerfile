FROM pgvector/pgvector:pg16

# pg_uuidv7's prebuilt release tarball is x86-64 only, so build from source
# to also work on arm64 (Apple Silicon dev machines).
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential git ca-certificates postgresql-server-dev-16 \
  && git clone --depth 1 --branch v1.7.0 https://github.com/fboulnois/pg_uuidv7.git /tmp/pg_uuidv7 \
  && make -C /tmp/pg_uuidv7 \
  && make -C /tmp/pg_uuidv7 install \
  && rm -rf /tmp/pg_uuidv7 \
  && apt-get purge -y --auto-remove build-essential git postgresql-server-dev-16 \
  && rm -rf /var/lib/apt/lists/*

COPY init/ /docker-entrypoint-initdb.d/
