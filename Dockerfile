# Aider Studio — Docker image for running aider without local install
# Build:  docker build -t aider-studio .
# Or use the official image (default in settings): paulgauthier/aider

FROM python:3.12-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*

# Pinned for reproducibility — the extension parses aider's output, so an
# unpinned upgrade could silently change the UI contract. Bump deliberately.
RUN pip install --no-cache-dir "aider-chat[browser]==0.86.2"

WORKDIR /workspace

# aider reads stdin interactively
ENTRYPOINT ["aider"]
