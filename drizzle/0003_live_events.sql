ALTER TABLE event ADD COLUMN hidden integer NOT NULL DEFAULT 0 CONSTRAINT event_hidden_boolean CHECK (hidden IN (0, 1));
ALTER TABLE event ADD COLUMN cancelled_at integer;
CREATE TABLE event_audit (
  id text PRIMARY KEY NOT NULL,
  event_id text NOT NULL REFERENCES event(id),
  actor_id text NOT NULL REFERENCES user(id),
  action text NOT NULL,
  changed_fields text,
  created_at integer NOT NULL
);
CREATE INDEX event_audit_time ON event_audit(event_id, created_at);
CREATE TABLE event_notification (
  id text PRIMARY KEY NOT NULL,
  operation_id text NOT NULL,
  user_id text NOT NULL REFERENCES user(id),
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CONSTRAINT event_notification_status CHECK(status IN ('pending','sending','sent','local')),
  attempts integer NOT NULL DEFAULT 0,
  lease_until integer,
  created_at integer NOT NULL,
  sent_at integer
);
CREATE INDEX event_notification_pending ON event_notification(status, created_at);
CREATE INDEX event_notification_operation ON event_notification(operation_id);

CREATE TRIGGER signup_visible_insert BEFORE INSERT ON signup WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'signup_not_eligible') WHERE EXISTS (
    SELECT 1 FROM event WHERE id = NEW.event_id AND (hidden = 1 OR cancelled_at IS NOT NULL)
  );
END;
CREATE TRIGGER signup_visible_update BEFORE UPDATE OF status, event_id, user_id ON signup WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'signup_not_eligible') WHERE EXISTS (
    SELECT 1 FROM event WHERE id = NEW.event_id AND (hidden = 1 OR cancelled_at IS NOT NULL)
  );
END;
CREATE TRIGGER keep_last_organizer BEFORE UPDATE OF role ON user
WHEN OLD.role = 'organizer' AND NEW.role != 'organizer'
BEGIN
  SELECT RAISE(ABORT, 'last_organizer') WHERE (SELECT count(*) FROM user WHERE role = 'organizer') <= 1;
  SELECT RAISE(ABORT, 'last_organizer') WHERE NOT EXISTS (
    SELECT 1 FROM user u JOIN volunteer_status v ON v.user_id=u.id
    WHERE u.id != OLD.id AND u.role='organizer' AND v.active=1
  );
END;

CREATE TABLE organizer_bootstrap (
  id integer PRIMARY KEY CONSTRAINT organizer_bootstrap_once CHECK(id = 1),
  user_id text NOT NULL REFERENCES user(id),
  created_at integer NOT NULL
);
CREATE TRIGGER bootstrap_first_organizer BEFORE INSERT ON organizer_bootstrap
BEGIN
  SELECT RAISE(ABORT, 'organizer_already_exists') WHERE EXISTS (SELECT 1 FROM user WHERE role='organizer');
  SELECT RAISE(ABORT, 'organizer_not_ready') WHERE NOT EXISTS (
    SELECT 1 FROM user u JOIN profile p ON p.user_id=u.id JOIN volunteer_status v ON v.user_id=u.id
    WHERE u.id=NEW.user_id AND u.email_verified=1 AND u.two_factor_enabled=1 AND v.active=1
  );
END;
CREATE TRIGGER bootstrap_first_organizer_apply AFTER INSERT ON organizer_bootstrap
BEGIN
  UPDATE user SET role='organizer',updated_at=NEW.created_at WHERE id=NEW.user_id;
  INSERT INTO audit_log(id,actor_id,subject_id,action,changed_fields,created_at)
    VALUES(lower(hex(randomblob(16))),NEW.user_id,NEW.user_id,'role_changed','["role"]',NEW.created_at);
  DELETE FROM session WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER keep_last_active_organizer BEFORE UPDATE OF active ON volunteer_status
WHEN OLD.active = 1 AND NEW.active = 0 AND EXISTS (SELECT 1 FROM user WHERE id = OLD.user_id AND role = 'organizer')
BEGIN
  SELECT RAISE(ABORT, 'last_organizer') WHERE (
    SELECT count(*) FROM user u JOIN volunteer_status v ON v.user_id = u.id WHERE u.role = 'organizer' AND v.active = 1
  ) <= 1;
END;
