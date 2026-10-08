# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

FROM node:22-bookworm-slim AS frontend-builder

WORKDIR /src/app/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY frontend ./
COPY test-fixtures /src/app/test-fixtures
RUN pnpm run build

FROM python:3.14-slim AS runtime

WORKDIR /app

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/flightarchive ./flightarchive
COPY --from=frontend-builder /src/app/frontend/build ./frontend

EXPOSE 8080
CMD ["python", "-m", "flightarchive.container"]
