-- Pilotage PMO : schéma MySQL 8 / MariaDB 10.5+
-- Appliqué automatiquement au démarrage du serveur (CREATE TABLE IF NOT EXISTS).
-- Tout est en UTF-8 (utf8mb4). Aucune suppression physique : les projets supprimés sont archivés (deleted_at).

CREATE TABLE IF NOT EXISTS meta (
  k VARCHAR(64) NOT NULL,
  v VARCHAR(255) NOT NULL,
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(16) NOT NULL,
  email VARCHAR(190) NOT NULL,
  name VARCHAR(120) NOT NULL,
  role VARCHAR(10) NOT NULL DEFAULT 'editor',
  pass_hash VARCHAR(100) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(64) NOT NULL,
  v LONGTEXT NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  updated_by VARCHAR(120) NULL,
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS projects (
  id VARCHAR(40) NOT NULL,
  code VARCHAR(40) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  type VARCHAR(80) NOT NULL DEFAULT '',
  manager VARCHAR(120) NOT NULL DEFAULT '',
  sponsor VARCHAR(120) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'Planifié',
  priority VARCHAR(20) NOT NULL DEFAULT 'Moyenne',
  start_date DATE NULL,
  end_date DATE NULL,
  budget DECIMAL(18,2) NOT NULL DEFAULT 0,
  progress DECIMAL(5,2) NOT NULL DEFAULT 0,
  rag_manual VARCHAR(8) NOT NULL DEFAULT 'auto',
  description TEXT NULL,
  objectives TEXT NULL,
  quality LONGTEXT NULL,
  extra LONGTEXT NULL,
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  updated_by VARCHAR(120) NULL,
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY ix_projects_code (code),
  KEY ix_projects_status (status),
  KEY ix_projects_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tasks (
  project_id VARCHAR(40) NOT NULL,
  id VARCHAR(40) NOT NULL,
  pos INT NOT NULL DEFAULT 0,
  phase VARCHAR(120) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  owner VARCHAR(120) NOT NULL DEFAULT '',
  start_date DATE NULL,
  end_date DATE NULL,
  progress DECIMAL(5,2) NOT NULL DEFAULT 0,
  is_milestone TINYINT(1) NOT NULL DEFAULT 0,
  is_deploy TINYINT(1) NOT NULL DEFAULT 0,
  deps TEXT NULL,
  PRIMARY KEY (project_id, id),
  KEY ix_tasks_dates (end_date),
  CONSTRAINT fk_tasks_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS budget_lines (
  project_id VARCHAR(40) NOT NULL,
  id VARCHAR(40) NOT NULL,
  pos INT NOT NULL DEFAULT 0,
  category VARCHAR(120) NOT NULL DEFAULT '',
  label VARCHAR(255) NOT NULL DEFAULT '',
  planned DECIMAL(18,2) NOT NULL DEFAULT 0,
  committed DECIMAL(18,2) NOT NULL DEFAULT 0,
  actual DECIMAL(18,2) NOT NULL DEFAULT 0,
  etc DECIMAL(18,2) NULL,
  PRIMARY KEY (project_id, id),
  CONSTRAINT fk_lines_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS risks (
  project_id VARCHAR(40) NOT NULL,
  id VARCHAR(40) NOT NULL,
  pos INT NOT NULL DEFAULT 0,
  title VARCHAR(500) NOT NULL,
  category VARCHAR(60) NOT NULL DEFAULT '',
  probability TINYINT NOT NULL DEFAULT 3,
  impact TINYINT NOT NULL DEFAULT 3,
  owner VARCHAR(120) NOT NULL DEFAULT '',
  response VARCHAR(40) NOT NULL DEFAULT '',
  mitigation TEXT NULL,
  due_date DATE NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Ouvert',
  created_on DATE NULL,
  PRIMARY KEY (project_id, id),
  KEY ix_risks_status (status),
  CONSTRAINT fk_risks_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS status_updates (
  project_id VARCHAR(40) NOT NULL,
  id VARCHAR(40) NOT NULL,
  upd_date DATE NOT NULL,
  rag VARCHAR(8) NOT NULL DEFAULT 'ok',
  done TEXT NULL,
  next_steps TEXT NULL,
  issues TEXT NULL,
  decisions TEXT NULL,
  snapshot LONGTEXT NULL,
  PRIMARY KEY (project_id, id),
  KEY ix_updates_date (upd_date),
  CONSTRAINT fk_updates_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  user_id CHAR(16) NULL,
  user_name VARCHAR(120) NULL,
  action VARCHAR(40) NOT NULL,
  entity VARCHAR(40) NULL,
  entity_id VARCHAR(40) NULL,
  detail TEXT NULL,
  PRIMARY KEY (id),
  KEY ix_audit_at (at),
  KEY ix_audit_entity (entity, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO meta (k, v) VALUES ('schema_version', '1');
