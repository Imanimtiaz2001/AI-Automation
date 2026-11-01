-- The Postgres container creates the "placidway" application database from POSTGRES_DB.
-- n8n keeps its own state (workflows, credentials, executions, paused approval waits) in a separate database.
CREATE DATABASE n8n;
