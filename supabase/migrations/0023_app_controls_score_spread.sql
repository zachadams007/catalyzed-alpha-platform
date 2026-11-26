-- Catalyzed Alpha - Score-spread operator controls
-- =============================================================================
-- Adds two operator-tunable display knobs to app_controls:
--   score_spread_weight   float4  0..1   (maps to DISPLAY_DECOMPRESS_WEIGHT)
--   quality_cap_strength  float4  ≥ 0    (maps to QUALITY_CEILING_RISK_W)
--
-- Both default to the code-level constants so existing rows are untouched and
-- already-running clients see no change on upgrade.
--
-- The set_app_controls RPC is re-created with two additional nullable params
-- (NULL = leave unchanged, same pattern as every other control).
-- =============================================================================

-- Add columns idempotently so re-running this migration is safe.
alter table public.app_controls
  add column if not exists score_spread_weight  float4 not null default 0.3
    check (score_spread_weight  >= 0 and score_spread_weight  <= 1),
  add column if not exists quality_cap_strength float4 not null default 1.4
    check (quality_cap_strength >= 0);

-- Drop the previous 5-arg signature before recreating with 7 args.
drop function if exists public.set_app_controls(boolean, boolean, boolean, jsonb, text);

create or replace function public.set_app_controls(
  p_sample_mode          boolean default null,
  p_live_paused          boolean default null,
  p_enforce_budgets      boolean default null,
  p_budgets              jsonb   default null,
  p_active_variant       text    default null,
  p_score_spread_weight  float4  default null,
  p_quality_cap_strength float4  default null
)
returns public.app_controls
language plpgsql security definer set search_path = public as $$
declare
  v_email text := coalesce(auth.jwt() ->> 'email', '');
  v_row   public.app_controls;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_app_operator() then
    raise exception 'Operator privileges required';
  end if;
  -- Validate variant before touching the row.
  if p_active_variant is not null and p_active_variant not in ('champion', 'challenger') then
    raise exception 'Invalid active_variant: %', p_active_variant;
  end if;
  -- Validate score-spread knobs.
  if p_score_spread_weight is not null and (p_score_spread_weight < 0 or p_score_spread_weight > 1) then
    raise exception 'score_spread_weight must be between 0 and 1';
  end if;
  if p_quality_cap_strength is not null and p_quality_cap_strength < 0 then
    raise exception 'quality_cap_strength must be >= 0';
  end if;

  update public.app_controls
     set sample_mode          = coalesce(p_sample_mode,          sample_mode),
         live_paused          = case
                                  when coalesce(p_sample_mode, sample_mode) then true
                                  else coalesce(p_live_paused, live_paused)
                                end,
         enforce_budgets      = coalesce(p_enforce_budgets,      enforce_budgets),
         budgets              = coalesce(p_budgets,              budgets),
         active_variant       = coalesce(p_active_variant,       active_variant),
         score_spread_weight  = coalesce(p_score_spread_weight,  score_spread_weight),
         quality_cap_strength = coalesce(p_quality_cap_strength, quality_cap_strength),
         updated_by           = lower(v_email),
         updated_at           = now()
   where id = true
  returning * into v_row;

  return v_row;
end;
$$;

-- Grant identical to the prior migration.
revoke all on function public.set_app_controls(boolean, boolean, boolean, jsonb, text, float4, float4) from public;
grant execute on function public.set_app_controls(boolean, boolean, boolean, jsonb, text, float4, float4) to authenticated;
