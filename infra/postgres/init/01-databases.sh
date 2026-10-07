#!/bin/sh
# Runs once, on the first start of an empty Postgres volume.
# Creates one database and owner for Keycloak and one for pont.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-SQL
	CREATE USER "$KEYCLOAK_DB_USER" WITH PASSWORD '$KEYCLOAK_DB_PASSWORD';
	CREATE DATABASE "$KEYCLOAK_DB_NAME" OWNER "$KEYCLOAK_DB_USER";
	CREATE USER "$PONT_DB_USER" WITH PASSWORD '$PONT_DB_PASSWORD';
	CREATE DATABASE "$PONT_DB_NAME" OWNER "$PONT_DB_USER";
SQL
