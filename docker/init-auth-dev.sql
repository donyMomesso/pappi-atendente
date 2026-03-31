-- auth.users
CREATE TABLE auth.users (
  instance_id UUID,
  id UUID PRIMARY KEY,
  aud VARCHAR(255),
  role VARCHAR(255),
  email VARCHAR(255),
  encrypted_password VARCHAR(255),
  email_confirmed_at TIMESTAMPTZ,
  invited_at TIMESTAMPTZ,
  confirmation_token VARCHAR(255),
  confirmation_sent_at TIMESTAMPTZ,
  recovery_token VARCHAR(255),
  recovery_sent_at TIMESTAMPTZ,
  email_change_token_new VARCHAR(255),
  email_change VARCHAR(255),
  email_change_sent_at TIMESTAMPTZ,
  last_sign_in_at TIMESTAMPTZ,
  raw_app_meta_data JSONB,
  raw_user_meta_data JSONB,
  is_super_admin BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  phone TEXT UNIQUE,
  phone_confirmed_at TIMESTAMPTZ,
  phone_change TEXT DEFAULT '',
  phone_change_token VARCHAR(255) DEFAULT '',
  phone_change_sent_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ DEFAULT NULL,
  email_change_token_current VARCHAR(255) DEFAULT '',
  email_change_confirm_status SMALLINT DEFAULT 0,
  banned_until TIMESTAMPTZ,
  reauthentication_token VARCHAR(255) DEFAULT '',
  reauthentication_sent_at TIMESTAMPTZ,
  is_sso_user BOOLEAN DEFAULT FALSE NOT NULL,
  deleted_at TIMESTAMPTZ,
  is_anonymous BOOLEAN DEFAULT FALSE NOT NULL
);
CREATE INDEX ON auth.users(instance_id);
CREATE INDEX ON auth.users(is_anonymous);

-- auth.identities
CREATE TABLE auth.identities (
  provider_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_data JSONB NOT NULL,
  provider TEXT NOT NULL,
  last_sign_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  email TEXT DEFAULT NULL,
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  CONSTRAINT identities_provider_id_provider_unique UNIQUE(provider_id, provider)
);
CREATE INDEX ON auth.identities(email);
CREATE INDEX ON auth.identities(user_id);

-- auth.oauth_clients (needed before sessions FK)
CREATE TABLE auth.oauth_clients (
  id UUID PRIMARY KEY,
  client_secret_hash TEXT,
  registration_type auth.oauth_registration_type NOT NULL,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  client_name TEXT,
  client_uri TEXT,
  logo_uri TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  deleted_at TIMESTAMPTZ,
  client_type auth.oauth_client_type DEFAULT 'confidential' NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL
);
CREATE INDEX ON auth.oauth_clients(deleted_at);

-- auth.sessions
CREATE TABLE auth.sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  factor_id UUID,
  aal auth.aal_level,
  not_after TIMESTAMPTZ,
  refreshed_at TIMESTAMP,
  user_agent TEXT,
  ip INET,
  tag TEXT,
  oauth_client_id UUID REFERENCES auth.oauth_clients(id) ON DELETE CASCADE,
  refresh_token_hmac_key TEXT,
  refresh_token_counter BIGINT,
  scopes TEXT
);
CREATE INDEX ON auth.sessions(not_after DESC);
CREATE INDEX ON auth.sessions(oauth_client_id);
CREATE INDEX ON auth.sessions(user_id);
CREATE INDEX user_id_created_at_idx ON auth.sessions(user_id, created_at);

-- auth.mfa_amr_claims
CREATE TABLE auth.mfa_amr_claims (
  session_id UUID NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  authentication_method TEXT NOT NULL,
  id UUID PRIMARY KEY,
  CONSTRAINT mfa_amr_claims_session_id_authentication_method_pkey UNIQUE(session_id, authentication_method)
);

-- auth.mfa_factors
CREATE TABLE auth.mfa_factors (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  friendly_name TEXT,
  factor_type auth.factor_type NOT NULL,
  status auth.factor_status NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  secret TEXT,
  phone TEXT,
  last_challenged_at TIMESTAMPTZ UNIQUE,
  web_authn_credential JSONB,
  web_authn_aaguid UUID,
  last_webauthn_challenge_data JSONB,
  CONSTRAINT unique_phone_factor_per_user UNIQUE(user_id, phone)
);
CREATE INDEX factor_id_created_at_idx ON auth.mfa_factors(user_id, created_at);
CREATE INDEX ON auth.mfa_factors(user_id);

-- auth.mfa_challenges
CREATE TABLE auth.mfa_challenges (
  id UUID PRIMARY KEY,
  factor_id UUID NOT NULL REFERENCES auth.mfa_factors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  ip_address INET NOT NULL,
  otp_code TEXT,
  web_authn_session_data JSONB
);
CREATE INDEX mfa_challenge_created_at_idx ON auth.mfa_challenges(created_at DESC);

-- auth.refresh_tokens
CREATE TABLE auth.refresh_tokens (
  instance_id UUID,
  id BIGSERIAL PRIMARY KEY,
  token VARCHAR(255) UNIQUE,
  user_id VARCHAR(255),
  revoked BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  parent VARCHAR(255),
  session_id UUID REFERENCES auth.sessions(id) ON DELETE CASCADE
);
CREATE INDEX ON auth.refresh_tokens(instance_id);
CREATE INDEX ON auth.refresh_tokens(instance_id, user_id);
CREATE INDEX ON auth.refresh_tokens(parent);
CREATE INDEX ON auth.refresh_tokens(session_id, revoked);
CREATE INDEX ON auth.refresh_tokens(updated_at DESC);

-- auth.one_time_tokens
CREATE TABLE auth.one_time_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_type auth.one_time_token_type NOT NULL,
  token_hash TEXT NOT NULL,
  relates_to TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(user_id, token_type)
);
CREATE INDEX one_time_tokens_relates_to_hash_idx ON auth.one_time_tokens USING HASH(relates_to);
CREATE INDEX one_time_tokens_token_hash_hash_idx ON auth.one_time_tokens USING HASH(token_hash);

-- auth.audit_log_entries
CREATE TABLE auth.audit_log_entries (
  instance_id UUID,
  id UUID PRIMARY KEY,
  payload JSON,
  created_at TIMESTAMPTZ,
  ip_address VARCHAR(64) DEFAULT '' NOT NULL
);
CREATE INDEX audit_logs_instance_id_idx ON auth.audit_log_entries(instance_id);

-- auth.custom_oauth_providers
CREATE TABLE auth.custom_oauth_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_type TEXT NOT NULL,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  acceptable_client_ids TEXT[] DEFAULT '{}',
  scopes TEXT[] DEFAULT '{}',
  pkce_enabled BOOLEAN DEFAULT TRUE NOT NULL,
  attribute_mapping JSONB DEFAULT '{}' NOT NULL,
  authorization_params JSONB DEFAULT '{}' NOT NULL,
  enabled BOOLEAN DEFAULT TRUE NOT NULL,
  email_optional BOOLEAN DEFAULT FALSE NOT NULL,
  issuer TEXT,
  discovery_url TEXT,
  skip_nonce_check BOOLEAN DEFAULT FALSE NOT NULL,
  cached_discovery JSONB,
  discovery_cached_at TIMESTAMPTZ,
  authorization_url TEXT,
  token_url TEXT,
  userinfo_url TEXT,
  jwks_uri TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX ON auth.custom_oauth_providers(created_at);
CREATE INDEX ON auth.custom_oauth_providers(enabled);
CREATE INDEX ON auth.custom_oauth_providers(identifier);
CREATE INDEX ON auth.custom_oauth_providers(provider_type);

-- auth.flow_state
CREATE TABLE auth.flow_state (
  id UUID PRIMARY KEY,
  user_id UUID,
  auth_code TEXT,
  code_challenge_method auth.code_challenge_method,
  code_challenge TEXT,
  provider_type TEXT NOT NULL,
  provider_access_token TEXT,
  provider_refresh_token TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  authentication_method TEXT NOT NULL,
  auth_code_issued_at TIMESTAMPTZ,
  invite_token TEXT,
  referrer TEXT,
  oauth_client_state_id UUID,
  linking_target_id UUID,
  email_optional BOOLEAN DEFAULT FALSE NOT NULL
);
CREATE INDEX ON auth.flow_state(created_at DESC);
CREATE INDEX idx_auth_code ON auth.flow_state(auth_code);
CREATE INDEX idx_user_id_auth_method ON auth.flow_state(user_id, authentication_method);

-- auth.instances
CREATE TABLE auth.instances (
  id UUID PRIMARY KEY,
  uuid UUID,
  raw_base_config TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

-- auth.oauth_authorizations
CREATE TABLE auth.oauth_authorizations (
  id UUID PRIMARY KEY,
  authorization_id TEXT NOT NULL UNIQUE,
  client_id UUID NOT NULL REFERENCES auth.oauth_clients(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT,
  resource TEXT,
  code_challenge TEXT,
  code_challenge_method auth.code_challenge_method,
  response_type auth.oauth_response_type DEFAULT 'code' NOT NULL,
  status auth.oauth_authorization_status DEFAULT 'pending' NOT NULL,
  authorization_code TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  expires_at TIMESTAMPTZ DEFAULT (NOW() + '00:03:00'::INTERVAL) NOT NULL,
  approved_at TIMESTAMPTZ,
  nonce TEXT
);

-- auth.oauth_client_states
CREATE TABLE auth.oauth_client_states (
  id UUID PRIMARY KEY,
  provider_type TEXT NOT NULL,
  code_verifier TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_oauth_client_states_created_at ON auth.oauth_client_states(created_at);

-- auth.oauth_consents
CREATE TABLE auth.oauth_consents (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES auth.oauth_clients(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  granted_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT oauth_consents_user_client_unique UNIQUE(user_id, client_id)
);
CREATE INDEX oauth_consents_user_order_idx ON auth.oauth_consents(user_id, granted_at DESC);

-- auth.sso_providers
CREATE TABLE auth.sso_providers (
  id UUID PRIMARY KEY,
  resource_id TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  disabled BOOLEAN
);
CREATE INDEX sso_providers_resource_id_pattern_idx ON auth.sso_providers(resource_id);

-- auth.saml_providers
CREATE TABLE auth.saml_providers (
  id UUID PRIMARY KEY,
  sso_provider_id UUID NOT NULL REFERENCES auth.sso_providers(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL UNIQUE,
  metadata_xml TEXT NOT NULL,
  metadata_url TEXT,
  attribute_mapping JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  name_id_format TEXT
);
CREATE INDEX ON auth.saml_providers(sso_provider_id);

-- auth.saml_relay_states
CREATE TABLE auth.saml_relay_states (
  id UUID PRIMARY KEY,
  sso_provider_id UUID NOT NULL REFERENCES auth.sso_providers(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  for_email TEXT,
  redirect_to TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  flow_state_id UUID REFERENCES auth.flow_state(id) ON DELETE CASCADE
);
CREATE INDEX ON auth.saml_relay_states(created_at DESC);
CREATE INDEX ON auth.saml_relay_states(for_email);
CREATE INDEX ON auth.saml_relay_states(sso_provider_id);

-- auth.schema_migrations
CREATE TABLE auth.schema_migrations (
  version VARCHAR(255) PRIMARY KEY
);

-- auth.sso_domains
CREATE TABLE auth.sso_domains (
  id UUID PRIMARY KEY,
  sso_provider_id UUID NOT NULL REFERENCES auth.sso_providers(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
CREATE INDEX ON auth.sso_domains(sso_provider_id);

-- auth.webauthn_challenges
CREATE TABLE auth.webauthn_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  challenge_type TEXT NOT NULL,
  session_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON auth.webauthn_challenges(expires_at);
CREATE INDEX ON auth.webauthn_challenges(user_id);

-- auth.webauthn_credentials
CREATE TABLE auth.webauthn_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_id BYTEA NOT NULL UNIQUE,
  public_key BYTEA NOT NULL,
  attestation_type TEXT DEFAULT '' NOT NULL,
  aaguid UUID,
  sign_count BIGINT DEFAULT 0 NOT NULL,
  transports JSONB DEFAULT '[]' NOT NULL,
  backup_eligible BOOLEAN DEFAULT FALSE NOT NULL,
  backed_up BOOLEAN DEFAULT FALSE NOT NULL,
  friendly_name TEXT DEFAULT '' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX ON auth.webauthn_credentials(user_id);
