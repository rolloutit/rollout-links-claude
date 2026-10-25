---
name: link-contacts
description: >-
  Add or update people in the Rollout Links shared contact list (LinkedIn member id → name, company, position,
  profile URL) so link opens show real names in Slack, and look people up in it. Use when the user shares a
  Linked Helper CSV export or a list of prospects for Rollout Links, asks why opens show only an ID, or says
  "töltsd fel a kontaktokat", "add these contacts", "ki ez a member id".
---

# Rollout Links contacts

Uses the Rollout Links connector tools `upload_contacts` and `search_contacts`. Reply in the user's language.

## Why it matters

Tracked links carry `h={memberId}` (Linked Helper's member id). An open is shown with a name only when that id
is in the shared contact list. The list is shared by the whole team.

## Uploading

1. Map the user's data to the tool fields. Linked Helper exports use these columns:
   - `member_id` → `member_id` (required; rows without it are skipped, say how many)
   - `first_name` / `custom_first_name`, `last_name` / `custom_last_name` (the `custom_` value wins when filled)
   - `current_company` / `current_company_custom` → `company`
   - `current_company_position` / `current_company_custom_position` → `position`
   - `profile_url` → `profile_url` (prefer a `linkedin.com/in/…` URL; build it from `public_id` when only a
     Sales Navigator URL is present)
   - `headline` → `headline`
2. Send at most 500 contacts per `upload_contacts` call. For more than ~1,000 rows, recommend the Contacts page
   in the browser (Rollout Links → Contacts → upload the CSV); it is faster and handles any size.
3. Report how many were added/updated. Existing values are never overwritten with empty ones.

Never invent member ids: a contact without the real Linked Helper member id is useless for matching.

## Looking up

`search_contacts` searches name, company, position or an exact member id. Use it to answer "who is h=12345?"
or to check whether someone is already in the list.
