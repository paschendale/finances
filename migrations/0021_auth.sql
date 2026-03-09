-- Create roles if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
END
$$;

-- Standard pgjwt implementation (simplified)
-- Based on: https://github.com/michelp/pgjwt

CREATE OR REPLACE FUNCTION url_encode(data bytea) RETURNS text AS $$
    SELECT translate(regexp_replace(encode(data, 'base64'), '\s+', '', 'g'), '+/=', '-_');
$$ LANGUAGE SQL IMMUTABLE;

CREATE OR REPLACE FUNCTION url_decode(data text) RETURNS bytea AS $$
BEGIN
    RETURN decode(translate(data, '-_', '+/'), 'base64');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION algorithm_sign(signables text, secret text, algorithm text)
RETURNS text AS $$
BEGIN
  IF algorithm = 'HS256' THEN
    RETURN url_encode(hmac(signables, secret, 'sha256'));
  ELSE
    RAISE EXCEPTION 'Unknown algorithm %', algorithm;
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION sign(payload json, secret text, algorithm text DEFAULT 'HS256')
RETURNS text AS $$
DECLARE
  header json;
  signables text;
BEGIN
  header := jsonb_build_object('typ', 'JWT', 'alg', algorithm);
  signables := url_encode(header::text::bytea) || '.' || url_encode(payload::jsonb::text::bytea);
  RETURN signables || '.' || algorithm_sign(signables, secret, algorithm);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION verify(token text, secret text, algorithm text DEFAULT 'HS256')
RETURNS table(header json, payload json, valid boolean) AS $$
DECLARE
  parts text[];
  header json;
  payload json;
  valid boolean;
BEGIN
  parts := string_to_array(token, '.');
  IF array_length(parts, 1) <> 3 THEN
    RETURN QUERY SELECT NULL::json, NULL::json, false;
  END IF;

  header := url_decode(parts[1])::text::jsonb::json;
  payload := url_decode(parts[2])::text::jsonb::json;
  valid := algorithm_sign(parts[1] || '.' || parts[2], secret, algorithm) = parts[3];

  RETURN QUERY SELECT header, payload, valid;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Auth table
CREATE TABLE IF NOT EXISTS auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  description text,
  created_at timestamptz DEFAULT now(),
  revoked boolean DEFAULT false
);

-- Login function
CREATE OR REPLACE FUNCTION login_with_token(token text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  jwt_secret text;
  jwt_token text;
BEGIN
  -- Get secret from app.jwt_secret setting
  BEGIN
    jwt_secret := current_setting('app.jwt_secret');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'app.jwt_secret is not set in database. Please run: ALTER DATABASE your_db_name SET app.jwt_secret = ''your-secret'';';
  END;

  -- Check if token exists
  IF NOT EXISTS (
    SELECT 1 FROM auth_tokens
    WHERE token_hash = encode(digest(token, 'sha256'), 'hex')
    AND revoked = false
  ) THEN
    RAISE EXCEPTION 'invalid or revoked token' USING ERRCODE = 'P0001';
  END IF;

  -- Generate JWT
  SELECT sign(
    row_to_json(r), 
    jwt_secret
  )
  into jwt_token
  from (
    select
      'authenticated' as role,
      extract(epoch from (now() + interval '7 days'))::integer as exp
  ) r;

  return jwt_token;
END;
$$;

-- Grant permissions
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;

-- Allow anon to call login
GRANT EXECUTE ON FUNCTION login_with_token(text) TO anon;

-- Broad permissions for authenticated role
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

-- Default privileges for future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
