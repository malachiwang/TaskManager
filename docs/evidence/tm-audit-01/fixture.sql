BEGIN TRANSACTION;
CREATE TABLE academic_batches (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            context_id  INTEGER          REFERENCES contexts(id) ON DELETE SET NULL,
            source_name TEXT    NOT NULL DEFAULT '',
            created_at  TEXT    NOT NULL
        );
CREATE TABLE academic_candidates (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id       INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
            context_id     INTEGER          REFERENCES contexts(id) ON DELETE SET NULL,
            kind           TEXT    NOT NULL,
            title          TEXT    NOT NULL,
            date           TEXT             DEFAULT NULL,
            start_minutes  INTEGER          DEFAULT NULL,
            end_minutes    INTEGER          DEFAULT NULL,
            weekdays       TEXT    NOT NULL DEFAULT '[]',
            source_text    TEXT    NOT NULL DEFAULT '',
            status         TEXT    NOT NULL DEFAULT 'pending',
            duplicate_of   TEXT             DEFAULT NULL,
            date_conflict  TEXT             DEFAULT NULL,
            created_record TEXT             DEFAULT NULL,
            created_at     TEXT    NOT NULL,
            updated_at     TEXT    NOT NULL,
            CHECK (status IN ('pending', 'approved', 'rejected'))
        );
CREATE TABLE archive_snapshots (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                name               TEXT    NOT NULL,
                start_date         TEXT    NOT NULL,
                end_date           TEXT    NOT NULL,
                archived_at        TEXT    NOT NULL,
                snapshot_data_json TEXT    NOT NULL
            );
INSERT INTO "archive_snapshots" VALUES(1,'January loadout','2025-01-01','2025-01-31','2026-10-29T15:02:37.863640','{"snapshot_schema_version": 2, "start_date": "2025-01-01", "end_date": "2025-01-31", "tasks": [{"id": 1, "name": "Original historical task", "section": "General", "category": "", "subtask": "Subtask needle", "priority": 5, "interval_days": 7, "status": "active", "notes": "", "created_at": "2026-10-29", "paused_at": null, "is_active": 1, "is_paused": 0, "manual_last_done_override": null, "display_order": 0, "active_from": "2026-10-29", "end_date": null, "depth": null, "estimated_minutes": null, "due_date": null, "context_id": null, "latest_completion": "2025-01-12", "days_overdue": 0, "overdue_ratio": 0.0, "effective_last_done": "2026-10-29", "days_since": 0, "urgency": 1.0, "is_scheduled": false, "is_ended": false, "completions": {"2025-01-12": 2}, "cell_notes": {"2025-01-12": "January note needle"}}]}');
CREATE TABLE cell_notes (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id    INTEGER NOT NULL REFERENCES tasks(id),
                note_date  TEXT    NOT NULL,
                note       TEXT    NOT NULL DEFAULT '',
                created_at TEXT    NOT NULL,
                updated_at TEXT    NOT NULL,
                UNIQUE (task_id, note_date)
            );
INSERT INTO "cell_notes" VALUES(1,1,'2025-01-12','January note needle','2026-10-29T15:02:37.860330','2026-10-29T15:02:37.860330');
CREATE TABLE completions (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id            INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                completion_date    TEXT    NOT NULL,
                completion_count   INTEGER NOT NULL DEFAULT 1,
                created_timestamp  TEXT    NOT NULL,
                updated_timestamp  TEXT    NOT NULL,
                CHECK (completion_count >= 0),
                UNIQUE (task_id, completion_date)
            );
INSERT INTO "completions" VALUES(1,1,'2025-01-12',2,'2026-10-29T15:02:37.857383','2026-10-29T15:02:37.858900');
INSERT INTO "completions" VALUES(2,2,'2026-10-28',1,'2026-10-29T15:02:37.872329','2026-10-29T15:02:37.872329');
INSERT INTO "completions" VALUES(3,4,'2026-10-28',1,'2026-10-29T15:02:37.877376','2026-10-29T15:02:37.877376');
INSERT INTO "completions" VALUES(4,6,'2026-10-28',1,'2026-10-29T15:02:37.881305','2026-10-29T15:02:37.881305');
INSERT INTO "completions" VALUES(5,8,'2026-10-28',1,'2026-10-29T15:02:37.885627','2026-10-29T15:02:37.885627');
CREATE TABLE context_event_links (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            context_id  INTEGER NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
            calendar_id INTEGER NOT NULL REFERENCES external_calendars(id) ON DELETE CASCADE,
            uid         TEXT    NOT NULL,
            created_at  TEXT    NOT NULL,
            UNIQUE (calendar_id, uid)
        );
CREATE TABLE contexts (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL,
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL
        );
CREATE TABLE date_cell_overrides (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            date       TEXT    NOT NULL,
            mode       TEXT    NOT NULL DEFAULT 'text',
            text       TEXT    NOT NULL DEFAULT '',
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL,
            UNIQUE (task_id, date)
        );
INSERT INTO "date_cell_overrides" VALUES(1,1,'2025-02-04','text','February text needle','2026-10-29T15:02:37.861886','2026-10-29T15:02:37.861886');
CREATE TABLE depth_window_skips (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            window_id  INTEGER NOT NULL REFERENCES depth_windows(id) ON DELETE CASCADE,
            date       TEXT    NOT NULL,
            created_at TEXT    NOT NULL,
            UNIQUE (window_id, date)
        );
CREATE TABLE depth_window_templates (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL,
            items      TEXT    NOT NULL DEFAULT '[]',
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL
        );
CREATE TABLE depth_windows (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            depth         INTEGER NOT NULL,
            date          TEXT             DEFAULT NULL,
            weekday       INTEGER          DEFAULT NULL,
            start_minutes INTEGER NOT NULL,
            end_minutes   INTEGER NOT NULL,
            protected     INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT    NOT NULL,
            updated_at    TEXT    NOT NULL,
            CHECK (depth IN (1, 2, 3)),
            CHECK (protected IN (0, 1)),
            CHECK (end_minutes > start_minutes),
            CHECK (start_minutes >= 0 AND end_minutes <= 1440),
            CHECK ((date IS NULL) != (weekday IS NULL)),
            CHECK (weekday IS NULL OR (weekday >= 0 AND weekday <= 6))
        );
CREATE TABLE external_calendars (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            name           TEXT    NOT NULL,
            url            TEXT    NOT NULL,
            visible        INTEGER NOT NULL DEFAULT 1,
            last_synced_at TEXT             DEFAULT NULL,
            last_error     TEXT             DEFAULT NULL,
            created_at     TEXT    NOT NULL,
            updated_at     TEXT    NOT NULL,
            CHECK (visible IN (0, 1))
        );
CREATE TABLE external_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            calendar_id INTEGER NOT NULL REFERENCES external_calendars(id) ON DELETE CASCADE,
            uid         TEXT    NOT NULL DEFAULT '',
            title       TEXT    NOT NULL DEFAULT '',
            start       TEXT    NOT NULL,
            end         TEXT    NOT NULL,
            all_day     INTEGER NOT NULL DEFAULT 0,
            CHECK (all_day IN (0, 1))
        );
CREATE TABLE reading_books (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            title         TEXT    NOT NULL,
            author        TEXT             DEFAULT '',
            total_pages   INTEGER          DEFAULT NULL,
            current_page  INTEGER NOT NULL DEFAULT 0,
            status        TEXT    NOT NULL DEFAULT 'active',
            started_at    TEXT             DEFAULT NULL,
            finished_at   TEXT             DEFAULT NULL,
            notes         TEXT             DEFAULT '',
            display_order INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT    NOT NULL,
            updated_at    TEXT    NOT NULL, priority INTEGER NOT NULL DEFAULT 3, to_buy INTEGER NOT NULL DEFAULT 0, purchase_url TEXT NOT NULL DEFAULT '', purchase_notes TEXT NOT NULL DEFAULT '', purchased_at TEXT DEFAULT NULL,
            CHECK (current_page >= 0),
            CHECK (total_pages IS NULL OR total_pages >= 0),
            CHECK (status IN ('active', 'finished', 'archived'))
        );
INSERT INTO "reading_books" VALUES(1,'Historical reading','Writer',NULL,42,'archived','2026-10-29',NULL,'Book needle',0,'2026-10-29T15:02:37.866881','2026-10-29T15:02:37.869020',3,0,'','',NULL);
INSERT INTO "reading_books" VALUES(2,'The Design of Everyday Things','Don Norman',NULL,0,'active','2026-10-29',NULL,'Disposable visual verification record',1,'2026-10-29T15:02:37.886553','2026-10-29T15:02:37.886553',3,0,'','',NULL);
INSERT INTO "reading_books" VALUES(3,'A Philosophy of Software Design','John Ousterhout',NULL,0,'active','2026-10-29',NULL,'Disposable visual verification record',2,'2026-10-29T15:02:37.887909','2026-10-29T15:02:37.887909',3,0,'','',NULL);
CREATE TABLE reading_entries (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id    INTEGER NOT NULL REFERENCES reading_books(id) ON DELETE CASCADE,
            entry_date TEXT    NOT NULL,
            page       INTEGER NOT NULL,
            note       TEXT             DEFAULT '',
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL,
            CHECK (page >= 0),
            UNIQUE (book_id, entry_date)
        );
INSERT INTO "reading_entries" VALUES(1,1,'2025-01-12',42,'Checkpoint needle','2026-10-29T15:02:37.869020','2026-10-29T15:02:37.869020');
CREATE TABLE recurrence_series (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id          INTEGER          REFERENCES tasks(id) ON DELETE CASCADE,
            title            TEXT    NOT NULL DEFAULT '',
            depth            INTEGER          DEFAULT NULL,
            context_id       INTEGER          DEFAULT NULL REFERENCES contexts(id) ON DELETE SET NULL,
            is_fixed         INTEGER NOT NULL DEFAULT 0,
            interval_weeks   INTEGER NOT NULL DEFAULT 1,
            weekdays         TEXT    NOT NULL DEFAULT '[]',
            start_date       TEXT    NOT NULL,
            start_minutes    INTEGER NOT NULL,
            duration_minutes INTEGER NOT NULL,
            until_date       TEXT             DEFAULT NULL,
            count            INTEGER          DEFAULT NULL,
            created_at       TEXT    NOT NULL,
            updated_at       TEXT    NOT NULL,
            CHECK (is_fixed IN (0, 1)),
            CHECK (interval_weeks >= 1),
            CHECK (start_minutes >= 0 AND start_minutes < 1440),
            CHECK (duration_minutes > 0),
            CHECK (count IS NULL OR count >= 1),
            CHECK (depth IS NULL OR depth IN (1, 2, 3)),
            CHECK (task_id IS NOT NULL OR TRIM(title) <> '')
        );
CREATE TABLE recurrence_skips (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            series_id  INTEGER NOT NULL REFERENCES recurrence_series(id) ON DELETE CASCADE,
            date       TEXT    NOT NULL,
            created_at TEXT    NOT NULL,
            UNIQUE (series_id, date)
        );
CREATE TABLE section_order (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL UNIQUE,
            position   INTEGER NOT NULL DEFAULT 0,
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL
        );
INSERT INTO "section_order" VALUES(1,'General',0,'2026-10-29T15:02:37.855285','2026-10-29T15:02:37.855285');
INSERT INTO "section_order" VALUES(2,'Work',1,'2026-10-29T15:02:37.870635','2026-10-29T15:02:37.870635');
INSERT INTO "section_order" VALUES(3,'Research',2,'2026-10-29T15:02:37.874069','2026-10-29T15:02:37.874069');
INSERT INTO "section_order" VALUES(4,'Personal',3,'2026-10-29T15:02:37.875733','2026-10-29T15:02:37.875733');
INSERT INTO "section_order" VALUES(5,'Study',4,'2026-10-29T15:02:37.882584','2026-10-29T15:02:37.882584');
CREATE TABLE task_daily_snapshots (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id             INTEGER NOT NULL,
            snapshot_date       TEXT    NOT NULL,
            task_name           TEXT    NOT NULL,
            section             TEXT,
            category            TEXT,
            status              TEXT    NOT NULL,
            is_paused           INTEGER NOT NULL DEFAULT 0,
            is_scheduled        INTEGER NOT NULL DEFAULT 0,
            active_from         TEXT,
            priority            INTEGER NOT NULL,
            interval_days       INTEGER NOT NULL,
            days_since          INTEGER,
            urgency             REAL,
            completion_count    INTEGER NOT NULL DEFAULT 0,
            effective_last_done TEXT,
            created_at          TEXT    NOT NULL,
            updated_at          TEXT    NOT NULL, end_date TEXT DEFAULT NULL, is_ended INTEGER NOT NULL DEFAULT 0,
            UNIQUE(task_id, snapshot_date)
        );
INSERT INTO "task_daily_snapshots" VALUES(1,1,'2026-10-29','Current task','General','','active',0,0,'2026-10-29',5,7,0,0.0,0,'2026-10-29','2026-10-29T15:27:47.946763','2026-10-29T20:55:04.052173','2025-03-31',1);
INSERT INTO "task_daily_snapshots" VALUES(2,2,'2026-10-29','Current active task','Work','','active',0,0,'2026-10-29',3,3,0,0.9,0,'2026-10-29','2026-10-29T15:27:47.946763','2026-10-29T20:55:04.052173',NULL,0);
INSERT INTO "task_daily_snapshots" VALUES(3,3,'2026-10-29','Prepare research outline','Research','','active',0,0,'2026-10-29',4,4,0,1.0,0,'2026-10-29','2026-10-29T15:27:47.946763','2026-10-29T20:55:04.052173',NULL,0);
INSERT INTO "task_daily_snapshots" VALUES(4,4,'2026-10-29','Practice piano','Personal','','active',0,0,'2026-10-29',5,5,0,1.0,0,'2026-10-29','2026-10-29T15:27:47.946763','2026-10-29T20:55:04.052173',NULL,0);
INSERT INTO "task_daily_snapshots" VALUES(5,5,'2026-10-29','Review project budget','Work','','active',0,0,'2026-10-29',6,6,0,1.1,0,'2026-10-29','2026-10-29T15:27:47.946763','2026-10-29T20:55:04.052173',NULL,0);
INSERT INTO "task_daily_snapshots" VALUES(6,6,'2026-10-29','Plan next week','Personal','','active',0,0,'2026-10-29',7,7,0,1.1,0,'2026-10-29','2026-10-29T15:27:47.946763','2026-10-29T20:55:04.052173',NULL,0);
INSERT INTO "task_daily_snapshots" VALUES(7,7,'2026-10-29','Read course notes','Study','','active',0,0,'2026-10-29',3,8,0,0.9,0,'2026-10-29','2026-10-29T15:27:47.946763','2026-10-29T20:55:04.052173',NULL,0);
INSERT INTO "task_daily_snapshots" VALUES(8,8,'2026-10-29','Back up project notes','Work','','active',0,0,'2026-10-29',4,9,0,1.0,0,'2026-10-29','2026-10-29T15:27:47.946763','2026-10-29T20:55:04.052173',NULL,0);
CREATE TABLE task_event_links (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            calendar_id    INTEGER NOT NULL REFERENCES external_calendars(id) ON DELETE CASCADE,
            uid            TEXT    NOT NULL,
            relation       TEXT    NOT NULL DEFAULT 'related',
            offset_minutes INTEGER          DEFAULT NULL,
            event_start    TEXT             DEFAULT NULL,
            created_at     TEXT    NOT NULL,
            updated_at     TEXT    NOT NULL,
            CHECK (relation IN ('related', 'before', 'after'))
        );
CREATE TABLE task_hiatus_periods (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            start_date TEXT    NOT NULL,
            end_date   TEXT             DEFAULT NULL,
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL
        );
CREATE TABLE task_sessions (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id        INTEGER          REFERENCES tasks(id) ON DELETE CASCADE,
            title          TEXT    NOT NULL DEFAULT '',
            depth          INTEGER          DEFAULT NULL,
            planned_start  TEXT    NOT NULL,
            planned_end    TEXT    NOT NULL,
            actual_start   TEXT             DEFAULT NULL,
            actual_end     TEXT             DEFAULT NULL,
            actual_minutes INTEGER          DEFAULT NULL,
            status         TEXT    NOT NULL DEFAULT 'scheduled',
            is_fixed       INTEGER NOT NULL DEFAULT 0,
            created_at     TEXT    NOT NULL,
            updated_at     TEXT    NOT NULL, context_id INTEGER DEFAULT NULL REFERENCES contexts(id) ON DELETE SET NULL, series_id INTEGER DEFAULT NULL REFERENCES recurrence_series(id) ON DELETE SET NULL, occurrence_date TEXT DEFAULT NULL, series_detached INTEGER NOT NULL DEFAULT 0,
            CHECK (status IN ('scheduled', 'completed', 'partial', 'skipped')),
            CHECK (is_fixed IN (0, 1)),
            CHECK (planned_end > planned_start),
            CHECK (depth IS NULL OR depth IN (1, 2, 3)),
            CHECK (task_id IS NOT NULL OR TRIM(title) <> '')
        );
INSERT INTO "task_sessions" VALUES(1,3,'',NULL,'2026-10-29T09:00','2026-10-29T10:00',NULL,NULL,NULL,'scheduled',0,'2026-10-29T15:37:03.691524','2026-10-29T15:37:03.691524',NULL,NULL,NULL,0);
INSERT INTO "task_sessions" VALUES(2,5,'',NULL,'2026-10-29T11:00','2026-10-29T12:00',NULL,NULL,NULL,'scheduled',0,'2026-10-29T15:37:03.694930','2026-10-29T15:37:03.694930',NULL,NULL,NULL,0);
INSERT INTO "task_sessions" VALUES(3,4,'',NULL,'2026-10-29T14:00','2026-10-29T15:00',NULL,NULL,NULL,'scheduled',0,'2026-10-29T15:37:03.696600','2026-10-29T15:37:03.696600',NULL,NULL,NULL,0);
CREATE TABLE tasks (
                id                       INTEGER PRIMARY KEY AUTOINCREMENT,
                name                     TEXT    NOT NULL,
                section                  TEXT    NOT NULL DEFAULT 'General',
                category                 TEXT    NOT NULL DEFAULT '',
                subtask                  TEXT             DEFAULT '',
                priority                 INTEGER NOT NULL DEFAULT 5,
                interval_days            INTEGER NOT NULL DEFAULT 7,
                status                   TEXT    NOT NULL DEFAULT 'active',
                notes                    TEXT             DEFAULT '',
                created_at               TEXT    NOT NULL,
                paused_at                TEXT             DEFAULT NULL,
                is_active                INTEGER NOT NULL DEFAULT 1,
                is_paused                INTEGER NOT NULL DEFAULT 0,
                manual_last_done_override TEXT            DEFAULT NULL,
                display_order            INTEGER NOT NULL DEFAULT 0,
                active_from              TEXT             DEFAULT NULL, end_date TEXT DEFAULT NULL, depth INTEGER DEFAULT NULL, estimated_minutes INTEGER DEFAULT NULL, due_date TEXT DEFAULT NULL, context_id INTEGER DEFAULT NULL REFERENCES contexts(id) ON DELETE SET NULL,
                CHECK (priority >= 1 AND priority <= 10),
                CHECK (interval_days > 0),
                CHECK (is_active IN (0, 1)),
                CHECK (is_paused IN (0, 1))
            );
INSERT INTO "tasks" VALUES(1,'Current task','General','','Subtask needle',5,7,'active','','2026-10-29',NULL,1,0,NULL,0,'2026-10-29','2025-03-31',NULL,NULL,NULL,NULL);
INSERT INTO "tasks" VALUES(2,'Current active task','Work','','',3,3,'active','Review weekly priorities','2026-10-29',NULL,1,0,NULL,1,'2026-10-29',NULL,NULL,NULL,NULL,NULL);
INSERT INTO "tasks" VALUES(3,'Prepare research outline','Research','','',4,4,'active','Collect sources for the introduction','2026-10-29',NULL,1,0,NULL,2,'2026-10-29',NULL,NULL,NULL,NULL,NULL);
INSERT INTO "tasks" VALUES(4,'Practice piano','Personal','','',5,5,'active','Scales and sight reading','2026-10-29',NULL,1,0,NULL,3,'2026-10-29',NULL,NULL,NULL,NULL,NULL);
INSERT INTO "tasks" VALUES(5,'Review project budget','Work','','',6,6,'active','Check estimates and outstanding invoices','2026-10-29',NULL,1,0,NULL,4,'2026-10-29',NULL,NULL,NULL,NULL,NULL);
INSERT INTO "tasks" VALUES(6,'Plan next week','Personal','','',7,7,'active','Balance study and rest','2026-10-29',NULL,1,0,NULL,5,'2026-10-29',NULL,NULL,NULL,NULL,NULL);
INSERT INTO "tasks" VALUES(7,'Read course notes','Study','','',3,8,'active','Summarize the current chapter','2026-10-29',NULL,1,0,NULL,6,'2026-10-29',NULL,NULL,NULL,NULL,NULL);
INSERT INTO "tasks" VALUES(8,'Back up project notes','Work','','',4,9,'active','Check the local copy','2026-10-29',NULL,1,0,NULL,7,'2026-10-29',NULL,NULL,NULL,NULL,NULL);
CREATE INDEX idx_snap_date
            ON task_daily_snapshots(snapshot_date);
CREATE INDEX idx_snap_task
            ON task_daily_snapshots(task_id);
CREATE INDEX idx_snap_section_date
            ON task_daily_snapshots(section, snapshot_date);
CREATE INDEX idx_reading_entries_book
            ON reading_entries(book_id);
CREATE INDEX idx_dco_date
            ON date_cell_overrides(date);
CREATE INDEX idx_thp_task
            ON task_hiatus_periods(task_id);
CREATE INDEX idx_thp_start
            ON task_hiatus_periods(start_date);
CREATE INDEX idx_sessions_task
            ON task_sessions(task_id);
CREATE INDEX idx_sessions_start
            ON task_sessions(planned_start);
CREATE INDEX idx_extev_cal
            ON external_events(calendar_id);
CREATE INDEX idx_extev_start
            ON external_events(start);
CREATE INDEX idx_tel_task ON task_event_links(task_id);
CREATE INDEX idx_tel_event ON task_event_links(calendar_id, uid);
CREATE INDEX idx_acand_batch
            ON academic_candidates(batch_id);
CREATE UNIQUE INDEX idx_sessions_series_occurrence
            ON task_sessions(series_id, occurrence_date)
            WHERE series_id IS NOT NULL AND occurrence_date IS NOT NULL;
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('tasks',8);
INSERT INTO "sqlite_sequence" VALUES('section_order',5);
INSERT INTO "sqlite_sequence" VALUES('completions',8);
INSERT INTO "sqlite_sequence" VALUES('cell_notes',1);
INSERT INTO "sqlite_sequence" VALUES('date_cell_overrides',4);
INSERT INTO "sqlite_sequence" VALUES('archive_snapshots',1);
INSERT INTO "sqlite_sequence" VALUES('reading_books',3);
INSERT INTO "sqlite_sequence" VALUES('reading_entries',1);
INSERT INTO "sqlite_sequence" VALUES('task_daily_snapshots',536);
INSERT INTO "sqlite_sequence" VALUES('task_sessions',3);
COMMIT;
