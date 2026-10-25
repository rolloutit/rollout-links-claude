---
name: tracked-link
description: >-
  Create, edit and analyse Rollout Links tracked links (link.rolloutit.net) with the Rollout Links connector:
  a short link that redirects to a target URL (e.g. a Google Drive deck), logs every open from LinkedIn /
  Linked Helper outreach and notifies a Slack channel. Use whenever the user wants a trackable / tracked link,
  wants to know who opened a link, or says things like "készíts egy trackelhető linket", "követhető link",
  "legyen követhető ezen a Slack channelen", "ki nyitotta meg a linkemet", "Linked Helper link".
---

# Tracked links with Rollout Links

You work through the **Rollout Links** MCP connector (tools such as `create_tracked_link`,
`list_slack_channels`, `get_link_stats`). If those tools are missing, tell the user to connect the connector
first (Rollout Links → MCP Settings has the steps) and stop.

Reply in the user's language (often Hungarian). Keep questions short.

## 1. Collect what the link needs

Required:
- **Target URL** – where the link leads (Google Drive file, deck, landing page). Must be http(s).
- **Title** – appears in every Slack notification ("Kiss Anna (CEO, Acme) opened: *AI Launch Day*").
  Propose one from context instead of asking an open question.

Slack notification:
- Call `list_slack_channels` and match the channel the user named (ignore `#`, case, accents).
- Nothing matches → show the available channels and ask. If the channel is not connected yet, it can only be
  added in the browser: give `connectNewChannelUrl` ("Slack → Add channel"), then offer to create the link
  now without a channel and attach it later with `update_tracked_link`.
- No channel wanted → create it without notification.
- `notify_mode`: default **every** (at most once per 30 min per person; repeat opens are a buying signal).
  Suggest **first** only for high-volume sends (hundreds of invites).

Optional — ask once, in one question, and accept "no":
- **Preview card** (what LinkedIn/Slack show for the link): `preview_title`, `preview_description`
  (≤ 300 chars), `preview_image_url` (public **https** image URL, ideally 1200×627). A local file or a Google
  Drive share link does not work as an image URL; ask for a publicly hosted image instead.
- **Short name** (`slug`, the part after `link.rolloutit.net/`). Default: derived from the title. If the user
  picks one, `check_slug` first and offer the suggestion when it is taken.
- **Source tag** (`source_tag`, the `s=` parameter, e.g. `k` for Kitti, `b` for Balázs) to tell senders apart.

Ask only for what is missing. Never invent a target URL or Slack channel.

## 2. Confirm, then create

Show a compact summary (title, target, Slack channel + mode, preview, slug) and create it with
`create_tracked_link` once the user agrees. If they already gave everything explicitly, create right away.

## 3. Hand over the result

Give back:
1. `linkedHelperUrl` in a code block, the line to paste into the Linked Helper message. `{memberId}` must stay
   literally as is: Linked Helper fills it in per recipient.
2. The dashboard link (`dashboardUrl`).
3. Two reminders: put nothing (no period or bracket) right after the link, ideally end the line with it; send
   a test message to your own profile before launching.

## Other things you can do

- "Who opened it?" → `get_link_stats` (by slug or id). Summarise: opens, unique people, then the people
  (name, position, company, number of opens, last open). Repeat openers are hot leads; call them out.
- "Who opened my links this week?" → `recent_opens` (`hours`: 168, `mine`: true). Group by person or company.
- Edit / switch off → `update_tracked_link` (only your own links unless you are an admin). Prefer
  `active: false` over deleting. Warn that changing the slug breaks links already sent.
- Opens without names mean the person is not in the contact list yet: offer the `link-contacts` skill.
