-- The name the in-app AI assistant goes by (chat button, panel header, and how
-- it introduces itself). Blank means the built-in default ("Sparky").
alter table company_settings add column if not exists ai_assistant_name text;
