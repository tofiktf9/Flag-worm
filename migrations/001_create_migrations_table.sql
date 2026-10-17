-- migrations/001_create_migrations_table.sql
-- سجل الترقيعات المطبّقة لتتبُّع المهاجرات (لا يتعارض مع أي شيء)
CREATE TABLE IF NOT EXISTS schema_migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT UNIQUE NOT NULL,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
