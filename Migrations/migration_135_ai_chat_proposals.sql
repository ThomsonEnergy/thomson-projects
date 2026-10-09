-- Changes the AI assistant has proposed in a chat reply (create a task, book
-- someone on the schedule...). The chat shows each with a Confirm button; the
-- change is only made when a person presses it.
alter table ai_chat_jobs add column if not exists proposals jsonb;
