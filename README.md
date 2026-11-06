# wp-lanes

Run several branches against one WordPress site at the same time. Each **lane** has its own plugin
directory (a farm of links to the base plugins, with the plugins under test pointing at a git
worktree) and its own clone of the database. The base checkout never switches branches. A request
picks its lane with a header, a cookie, or an environment variable.

Node 20 or newer, no npm dependencies. Works on Windows (junctions, so no admin rights) and on
macOS/Linux (symlinks).

```
npm link                                   # puts `wp-lanes` on PATH
wp-lanes init-site edd --domain edd.local  # reads everything else from Local
wp-lanes doctor
wp-lanes install-shim                      # once per site; patches wp-config.php and prints the diff
```

Site configs live in `~/.wp-lanes/sites/<site>.json` and are machine-specific. Pass `--site <name>`
when more than one is configured.

## Local auto-discovery

`init-site <name> --domain <domain>` reads Local's `sites.json`, finds the site with that domain and
fills in the config:

| Value | Where it comes from |
| --- | --- |
| web root | `<site.path>/app/public` (a leading `~` in `site.path` is expanded) |
| site URL | `https://<domain>` |
| PHP | `<Local>/lightning-services/php-<version>[+<n>]/bin/<platform>/php[.exe]` (or `.../bin/php`), with `-c <Local>/run/<siteId>/conf/php/php.ini` |
| MySQL bin dir | `<Local>/lightning-services/<mysql or mariadb>-<version>[+<n>]/bin/<platform>/bin` |
| MySQL port | `services.mysql.ports.MYSQL[0]`, re-read from `sites.json` on every run |
| MySQL user, password, database | the site's `mysql` record |
| WP-CLI | Local's bundled `wp-cli.phar`, else `wp` on PATH |

`<Local>` is `%APPDATA%/Local` on Windows and `~/Library/Application Support/Local` on macOS.
`<platform>` is `win64` on Windows, `darwin-arm64` then `darwin` on macOS. When several builds of
the version exist, the newest one whose binary is present wins.

Every flag still works and overrides the discovered value (`--php`, `--php-arg`, `--wp-cli`,
`--mysql-bin`, `--mysql-port`, `--site-url`, `--web-root`, `--local-sites-json`, ...). Without
`--domain`, pass them all yourself:

```
wp-lanes init-site edd --web-root D:/Local/Sites/edd/app/public --site-url https://edd.local \
  --php ".../php.exe" --php-arg -c --php-arg ".../php.ini" --wp-cli ".../wp-cli.phar" \
  --mysql-bin ".../mysql/bin" --mysql-port 10005 --mysql-user root --mysql-password root \
  --mysql-database local --local-sites-json ".../Local/sites.json" --local-site-id NcWK6ZoEI
```

If the site's config file already exists, `init-site` does nothing when the result is identical,
and otherwise prints a diff (password redacted) and stops. Pass `--force` to overwrite.

## Setting up on another machine

The Local site must already exist and be started on that machine. Then, in order:

```
git clone <wp-lanes repo> ~/Personal-Projects/wp-lanes
cd ~/Personal-Projects/wp-lanes
npm link
wp-lanes init-site edd --domain edd.local
wp-lanes doctor
wp-lanes install-shim
wp-lanes up smoke --from <a worktree of the plugins repo or of a plugin repo>
curl -skI -H "X-WP-Lane: smoke" https://edd.local/   # shows X-WP-Lane: smoke
wp-lanes down smoke
```

`doctor` prints every resolved path with `exists` or `missing` and ends with a `Next:` line naming
the command to run. Run it before `install-shim`: the shim shows as `TODO`, not as a failure. Run
with no site configured, it lists the domains Local knows and the `init-site` line for each.

If `wp-lanes` answers "permission denied" on macOS after `npm link`, run
`chmod +x bin/wp-lanes.js` in the checkout.

### Known differences on macOS

The macOS paths are taken from Local's documented layout and have not been run yet. They are
expected; confirm them with `wp-lanes doctor`.

- **Symlinks instead of junctions.** Lane plugin dirs are symlinks; `down` unlinks each one and
  never descends into it. No admin rights are needed on either platform.
- **php-fpm instead of php-cgi.** Local on macOS runs PHP-FPM, so the 2-worker limit under
  "Limits" is a Windows measurement; the macOS pool size is not measured.
- **`run/<siteId>` differs per machine.** Local gives the same site a different id on each machine,
  so the php.ini path and `localSiteId` differ. Never copy `~/.wp-lanes/sites/*.json` between
  machines; run `init-site --domain` on each.
- **sites.json location.** `~/Library/Application Support/Local/sites.json`, and `site.path` there is
  usually `~/Local Sites/<name>` (with a space). Both are expected, confirm with `wp-lanes doctor`.
- **PHP binary dir.** Expected at `.../bin/darwin-arm64/bin/php` (Apple silicon) or
  `.../bin/darwin/...` (Intel); discovery tries both. Confirm with `wp-lanes doctor`.
- **WP-CLI.** Expected at
  `/Applications/Local.app/Contents/Resources/extraResources/bin/wp-cli/wp-cli.phar`. If it is
  missing, discovery falls back to `wp` on PATH, which runs with its own PHP and not Local's
  php.ini; Local's `DB_HOST` uses a socket that only Local's php.ini knows, so `wp-lanes wp` may not
  reach the database. Point `wpCli` at Local's phar if that happens.
- **MySQL over TCP.** The tool's own `mysql`/`mysqldump` connect to `127.0.0.1:<port>` with the
  password in `MYSQL_PWD`, never on the command line. `doctor` shows whether that port answers.
- **`.local` lookups.** macOS can route `.local` names to Bonjour, which makes the first request
  slow; Local's hosts-file entry normally prevents it. Local's router must be in "Site Domains" mode
  for `https://<domain>` to resolve; `doctor`'s 200 check catches a mismatch.

## Commands

| Command | What it does |
| --- | --- |
| `up <lane> --from <worktree>` | Detects the overridden plugins, builds the lane, clones the DB. `--from` may repeat. |
| `up <lane> --override <pluginDir>=<path>` | Overrides one plugin dir explicitly. May repeat and mix with `--from`. |
| `up <lane> ... --no-db` | Lane uses the base database (writes hit the base site). |
| `down <lane>` | Removes the links one at a time, drops the lane DB, deletes the lane dir. Never follows a link. |
| `list` | Lanes with their overrides, DB and age. |
| `wp <lane> -- <args>` | Runs WP-CLI against the lane. The exit code passes through. |
| `db-reset <lane>` | Drops the lane DB and clones the base again. |
| `doctor` | Prints every resolved path (exists or missing), checks the shim, PHP, MySQL (re-reading Local's port), the base site and stale lanes, then names the next command to run. |

Lane names are 1-40 characters of `a-z 0-9 _ -`, starting with a letter or digit. `off` is reserved.

### How `--from` picks the overrides

- **A worktree of the plugins repo itself** (a monorepo): every top-level directory the branch
  changed since its merge-base with the base checkout's HEAD, including uncommitted and untracked
  changes. Top-level files and dot-directories are reported and skipped.
- **A worktree of a plugin that is its own repo** (e.g. `easy-digital-downloads-pro`,
  `edd-recurring`): that one plugin directory.
- Anything else is an error; use `--override`.

If an overridden worktree has no `vendor/` and the base plugin has one, `up` copies the base
`vendor/` into the worktree with a warning, and `down` deletes that copy. Run composer in the
worktree instead if the branch changed its dependencies.

## Selecting a lane (for agents)

Order of precedence, checked in `wp-config.php` on every request:

1. Request header `X-WP-Lane: <lane>`. Best for curl and for Playwright
   (`browser.newContext({ extraHTTPHeaders: { 'X-WP-Lane': 'pr856' } })`).
2. Query arg `?wp_lane=<lane>`: serves that lane and sets the `wp_lane` cookie (session cookie,
   `path=/`, `SameSite=Lax`, readable from JS). `?wp_lane=off` clears it.
3. Cookie `wp_lane=<lane>`: what a browser carries after step 2. Set it directly with
   `context.addCookies([{ name: 'wp_lane', value: 'pr856', url: 'https://edd.local' }])`.
4. Env `WP_LANE=<lane>`, CLI only. `wp-lanes wp` sets it for you.

An unknown or malformed name silently gets the base site.

**Prove which lane answered** from the response headers, which every lane request carries
(front end, admin, admin-ajax and REST):

```
X-WP-Lane: pr856
X-WP-Lane-DB: local_lane_pr856
X-WP-Lane-Plugins-Dir: D:/.../wp-content/lanes/pr856/plugins
X-WP-Lane-Overrides: edd-2checkout=C:/.../t3-0db4d270/edd-2checkout
```

The base site sends none of these. In wp-admin a red "Lane: pr856" node shows in the admin bar.

Temporary mu-plugins for a test go in `wp-content/lanes/<lane>/mu-plugins/`, never in the base
`mu-plugins/`; `down` deletes them with the lane. PHP notices from a lane land in
`wp-content/lanes/<lane>/debug.log`.

## What does NOT get routed to a lane

Only requests that carry the header or cookie reach a lane. Everything the server starts on its own
goes to the base site:

- **WP-Cron.** `spawn_cron()` makes a loopback request without the lane header.
- **Action Scheduler** queue runners (they ride on WP-Cron and async loopback requests).
- **Inbound webhooks** from gateways and other services.
- **Any other loopback request** (`wp_remote_get( home_url() )`, site health checks, async
  requests).

To run cron or Action Scheduler inside a lane, call it through WP-CLI:

```
wp-lanes wp pr856 -- cron event run --due-now
wp-lanes wp pr856 -- action-scheduler run
```

## How it works

- `install-shim` puts a short block at the top of `wp-config.php` that resolves the lane and
  `require`s `wp-content/lanes/<lane>/lane.php`, and changes `define( 'DB_NAME', ... )` to
  `defined( 'DB_NAME' ) || define( ... )`. Any other constant a lane defines is guarded the same
  way if wp-config defines it unguarded. The patched file is written to a temp path, linted with
  `php -l`, renamed over the original, and the site must answer 200 afterwards or the backup
  (`wp-config.php.bak-pre-lanes`) is restored automatically.
- `lane.php` defines `DB_NAME`, `WP_PLUGIN_DIR`/`URL`, `WPMU_PLUGIN_DIR`/`URL`, `WP_DEBUG_LOG` and
  `WP_CACHE_KEY_SALT` (so a persistent object cache never mixes lanes).
- `wp-content/lanes/<lane>/plugins/` holds one link per base plugin directory, links to the
  worktree for the overridden ones, and copies of loose `*.php` files. `mu-plugins/` is the same
  plus the generated `zz-wp-lane.php` marker plugin.
- The lane DB is `<baseDb>_lane_<lane>` (`-` becomes `_`), cloned with the site's own `mysqldump`
  and `mysql`. The password goes through `MYSQL_PWD`, never the command line.

Plugins that are not overridden are links to the base, so they follow whatever the base checkout
has. If someone switches a base repo's branch, every lane sees that switch too.

## Limits

- Local on Windows runs 2 php-cgi workers for the whole site, so requests across all lanes queue
  once more than 2 are in flight.
- Each lane DB is a full copy of the base DB; `up` takes a few seconds per 25 MB.
- A `--no-db` lane shares the base database, so its writes change the base site.
