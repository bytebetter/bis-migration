#!/usr/bin/env bash
# Shared table lists for selective DB migration / backup.
# shellcheck shell=bash

MIGRATE_TABLES=(
  locations
  holiday
  settings
  role_menu
  time_slot
  mobile_location
  patient_type
  pacs_riscode
  bx_code
  exam_reason
  referring_md
  location_surgery
  procedure_item
  nurse_work_statuses
  underlying_diseases
  bx_options
  tab_exam_option
  certificate_reason
  lab_list
  finance_cost
  tab_procedure_options
  tab_clinical_options
  tab_procedures_options
  tab_location_options
  tab_technique_options
  tab_result_options
  tab_recommendation_options
  tab_assessment_options
  payment_type
  donate_type
  lab_cost
  examination_cost
  procedure_cost
  exam_costs
  billing_discount
  place
  donate_for
  beds
  role_menu_directus_policies
  role_menu_directus_roles
)

DIRECTUS_TABLES=(
  directus_access
  directus_collections
  directus_dashboards
  directus_extensions
  directus_fields
  directus_files
  directus_flows
  directus_folders
  directus_migrations
  directus_notifications
  directus_operations
  directus_panels
  directus_permissions
  directus_policies
  directus_presets
  directus_relations
  directus_roles
  directus_sessions
  directus_settings
  directus_shares
  directus_translations
  directus_users
  directus_versions
  directus_webhooks
)

join_pg_tables() {
  local out=""
  local item=""
  for item in "$@"; do
    out+=" --table=public.${item}"
  done
  echo "$out"
}

# SQL_DATA_FORMAT=copy (default, fast restore via psql) | inserts (TablePlus / GUI clients)
pg_dump_data_format_args() {
  if [[ "${SQL_DATA_FORMAT:-copy}" == "inserts" ]]; then
    echo "--inserts"
  fi
}

strip_psql_meta_commands() {
  sed -E '/^\\restrict /d; /^\\unrestrict /d'
}
