use rusqlite::Connection;

use super::{DbError, DbResult};

pub const CURRENT_SCHEMA_VERSION: i32 = 1;

struct Migration {
    version: i32,
    #[allow(dead_code)]
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "initial_v0_1_schema",
    sql: include_str!("schema.sql"),
}];

pub fn current_user_version(conn: &Connection) -> DbResult<i32> {
    let version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    Ok(version)
}

pub fn run_migrations(conn: &mut Connection) -> DbResult<i32> {
    let mut version = current_user_version(conn)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(DbError::UnsupportedSchemaVersion {
            found: version,
            supported: CURRENT_SCHEMA_VERSION,
        });
    }

    for migration in MIGRATIONS {
        if migration.version > version {
            let tx = conn.transaction()?;
            tx.execute_batch(migration.sql)?;
            tx.pragma_update(None, "user_version", migration.version)?;
            tx.commit()?;
            version = migration.version;
        }
    }

    Ok(version)
}
