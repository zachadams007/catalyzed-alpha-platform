-- Catalyzed Alpha - Promotable engine versions V6 / V7
-- =============================================================================
-- `app_controls.active_variant` selects which engine normalization the live
-- feed ranks with. The column's CHECK constraint and the `set_app_controls`
-- RPC were written when only two variants existed ('champion' = V4,
-- 'challenger' = V5). The client has accepted 'v6' and 'v7' since 2026-09-17
-- (`sanitizeVariant`, `NORMALIZATION_FOR_VARIANT`), but the database still
-- rejected them - so V7 could be registered and scored in-app, never promoted.
--
-- This migration widens both checks to the four registered variants. Nothing
-- else changes: signature, grants and the singleton row are identical.
-- =============================================================================

alter table public.app_controls
  drop constraint if exists app_controls_active_variant_check;
alter table public.app_controls
  add constraint app_controls_active_variant_check
  check (active_variant in ('champion', 'challenger', 'v6', 'v7'));

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
  -- Validate variant before touching the row: the four registered engines.
  if p_active_variant is not null
     and p_active_variant not in ('champion', 'challenger', 'v6', 'v7') then
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

-- PostgREST caches the schema; refresh so the widened RPC is served immediately.
notify pgrst, 'reload schema';
