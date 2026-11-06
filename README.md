# wp-lanes

Test several branches live on one WordPress site at the same time. Each **lane** has its own plugin
directory (a farm of links to the base plugins, with the plugins under test pointing at a git
worktree) and its own clone of the database. The base checkout never switches branches; a request
picks its lane with a header, a cookie or an environment variable. Useful when several people or AI
agents test different branches against the same local site in parallel.

## Requirements

- Node 20 or newer. No npm dependencies.
- A local WordPress site you can reach over HTTP(S), with its PHP binary, WP-CLI and the MySQL or
  MariaDB client tools (`mysql`, `mysqldump`) on the same machine.
- Git, with the plugins under test checked out as git repositories inside `wp-content/plugins`.
- Windows (junctions, so no admin rights), macOS or Linux (symlinks).

[Local](https://localwp.com/) sites are discovered automatically; any other stack works with
explicit flags.

## Install

```
git clone https://github.com/mihaijoldis/wp-lanes.git
cd wp-lanes
npm link        # puts `wp-lanes` on PATH
```

If `wp-lanes` answers "permission denied" on macOS after `npm link`, run `chmod +x bin/wp-lanes.js`
in the checkout.

## Configure

Site configs live in `~/.wp-lanes/sites/<site>.json` and are machine-specific. Pass `--site <name>`
when more than one is configured.

```
wp-lanes init-site mysite --domain mysite.local
wp-lanes doctor
wp-lanes install-shim      # once per site; patches wp-config.php and prints the diff
```

`doctor` prints every resolved path with `exists` or `missing` and ends with a `Next:` line naming
the command to run. Run it before `install-shim`: the shim shows as `TODO`, not as a failure. Run
with no site configured, it lists the domains Local knows and the `init-site` line for each.

If the site's config file already exists, `init-site` does nothing when the result is identical,
and otherwise prints a diff (password redacted) and stops. Pass `--force` to overwrite.

### Local auto-discovery

`init-site <name> --domain <domain>` reads Local's `sites.json`, finds the site with that domain and
fills in the config:

- **Web root:** `<site.path>/app/public` (a leading `~` in `site.path` is expanded).
- **Site URL:** `https://<domain>`.
- **PHP:** `<Local>/lightning-services/php-<version>[+<n>]/bin/<platform>/php[.exe]` (or
  `.../bin/php`), run with `-c <Local>/run/<siteId>/conf/php/php.ini`.
- **MySQL client dir:** `<Local>/lightning-services/<mysql or mariadb>-<version>[+<n>]/bin/<platform>/bin`.
- **MySQL port:** `services.mysql.ports.MYSQL[0]`, re-read from `sites.json` on every run, since
  Local reassigns ports when its services restart.
- **MySQL socket (macOS/Linux):** `socket =` in `<Local>/run/<siteId>/conf/mysql/my.cnf`; when set,
  the client connects over it instead of the port.
- **MySQL user, password, database:** the site's `mysql` record.
- **WP-CLI:** Local's bundled `wp-cli.phar`, else `wp` on PATH.

`<Local>` is `%APPDATA%/Local` on Windows and `~/Library/Application Support/Local` on macOS.
`<platform>` is `win64` on Windows, `darwin-arm64` then `darwin` on macOS. When several builds of
the version exist, the newest one whose binary is present wins; a candidate counts only if it is a
file, not a directory of the same name.

After a Local update changes the site's PHP version or its `run/<id>` directory,
`init-site <name> --domain <domain> --force` picks up the new paths; the diff it prints first shows
what moved.

### Other stacks: explicit flags

Every value can be passed by flag, and a flag overrides what discovery finds (`--php`, `--php-arg`,
`--wp-cli`, `--mysql-bin`, `--mysql-port`, `--mysql-socket`, `--site-url`, `--web-root`,
`--local-sites-json`, ...). Without `--domain`, pass them all yourself:

```
wp-lanes init-site mysite --web-root /srv/mysite/public --site-url https://mysite.test \
  --php /usr/bin/php --wp-cli wp --mysql-bin /usr/bin \
  --mysql-host 127.0.0.1 --mysql-port 3306 --mysql-user root --mysql-password root \
  --mysql-database mysite
```

`--php-arg` repeats for extra PHP arguments (for example `--php-arg -c --php-arg <path to php.ini>`).
`--plugins-dir`, `--mu-plugins-dir` and `--wp-config` override the paths derived from the web root.

### Docker stacks

Untested. A lane's plugin directory holds links to absolute host paths of your git worktrees, so
the web server's PHP must see those worktrees at the same paths: every worktree has to be mounted
into the container, and the links must resolve there. PHP, WP-CLI and the MySQL client also have to
be runnable from the host (wrapper scripts that `docker exec` into the container, passed with
`--php`, `--wp-cli` and `--mysql-bin`).

## Daily use

The one rule: never check out, reset or stash a branch in the site's `wp-content/plugins` or in any
repo nested inside it. Those are the base every lane links to, so a switch there changes every lane
at once. Branches live in git worktrees and reach the site through `wp-lanes up`.

```
git -C <site>/wp-content/plugins/my-plugin worktree add ~/worktrees/my-plugin-fix fix-branch
wp-lanes up fix --from ~/worktrees/my-plugin-fix
curl -skI -H "X-WP-Lane: fix" https://mysite.local/     # shows X-WP-Lane: fix
wp-lanes down fix
```

### How `--from` picks the overrides

- **A worktree of the plugins repo** (when `wp-content/plugins` is itself one git repository holding
  many plugins): every top-level directory the branch changed since its merge-base with the base
  checkout's HEAD, including uncommitted and untracked changes. Top-level files and dot-directories
  are reported and skipped.
- **A worktree of a plugin's own repo** (e.g. `wp-content/plugins/my-plugin` is its own git
  repository): that one plugin directory.
- Anything else is an error; use `--override <pluginDir>=<path>`.

If an overridden worktree has no `vendor/` and the base plugin has one, `up` copies the base
`vendor/` into the worktree with a warning, and `down` deletes that copy. Run composer in the
worktree instead if the branch changed its dependencies.

### Selecting a lane

Order of precedence, checked in `wp-config.php` on every request:

1. Request header `X-WP-Lane: <lane>`. Best for curl and for Playwright
   (`browser.newContext({ extraHTTPHeaders: { 'X-WP-Lane': 'fix' } })`).
2. Query arg `?wp_lane=<lane>`: serves that lane and sets the `wp_lane` cookie (session cookie,
   `path=/`, `SameSite=Lax`, readable from JS), so a browser stays in the lane while you click
   around. `?wp_lane=off` clears it.
3. Cookie `wp_lane=<lane>`: what a browser carries after step 2. Set it directly with
   `context.addCookies([{ name: 'wp_lane', value: 'fix', url: 'https://mysite.local' }])`.
4. Env `WP_LANE=<lane>`, CLI only. `wp-lanes wp <lane> -- <wp-cli args>` sets it for you.

An unknown or malformed name silently gets the base site.

Every lane response (front end, admin, admin-ajax and REST) carries headers that prove which lane
answered:

```
X-WP-Lane: fix
X-WP-Lane-DB: local_lane_fix
X-WP-Lane-Plugins-Dir: <site>/wp-content/lanes/fix/plugins
X-WP-Lane-Overrides: my-plugin=/home/you/worktrees/my-plugin-fix
```

The base site sends none of these. In wp-admin a red "Lane: fix" node shows in the admin bar.

Temporary mu-plugins for a test go in `wp-content/lanes/<lane>/mu-plugins/`, never in the base
`mu-plugins/`; `down` deletes them with the lane. PHP notices from a lane land in
`wp-content/lanes/<lane>/debug.log`.

## Commands

| Command | What it does |
| --- | --- |
| `init-site <name> --domain <domain>` | Writes the site config from Local's records; flags override. |
| `install-shim` | Patches `wp-config.php` with the lane selector (once per site). |
| `up <lane> --from <worktree>` | Detects the overridden plugins, builds the lane, clones the DB. `--from` may repeat. |
| `up <lane> --override <pluginDir>=<path>` | Overrides one plugin dir explicitly. May repeat and mix with `--from`. |
| `up <lane> ... --no-db` | Lane uses the base database (writes hit the base site). |
| `down <lane>` | Removes the links one at a time, drops the lane DB, deletes the lane dir. Never follows a link. |
| `list` | Lanes with their overrides, DB and age. |
| `wp <lane> -- <args>` | Runs WP-CLI against the lane. The exit code passes through. |
| `db-reset <lane>` | Drops the lane DB and clones the base again. |
| `doctor` | Prints every resolved path, checks the shim, PHP, MySQL, the base site and stale lanes, then names the next command to run. |

Lane names are 1-40 characters of `a-z 0-9 _ -`, starting with a letter or digit. `off` is reserved.

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

## What is not routed to a lane

Only requests that carry the header or cookie reach a lane. Everything the server starts on its own
goes to the base site:

- **WP-Cron.** `spawn_cron()` makes a loopback request without the lane header.
- **Action Scheduler** queue runners (they ride on WP-Cron and async loopback requests).
- **Inbound webhooks** from payment gateways and other services.
- **Any other loopback request** (`wp_remote_get( home_url() )`, site health checks, async
  requests).

To run cron or Action Scheduler inside a lane, call it through WP-CLI:

```
wp-lanes wp fix -- cron event run --due-now
wp-lanes wp fix -- action-scheduler run
```

## Limits

- Local runs 2 PHP workers for the whole site (php-cgi on Windows, a static php-fpm pool on
  macOS), so requests across all lanes queue once more than 2 are in flight.
- Each lane DB is a full copy of the base DB; `up` takes a few seconds per 25 MB.
- A `--no-db` lane shares the base database, so its writes change the base site.

## Setting up another machine

The site must already exist and be running on that machine. Then, in order:

```
npm link                                          # in your clone of this repository
wp-lanes init-site mysite --domain mysite.local   # name the config whatever you like
wp-lanes doctor
wp-lanes install-shim
wp-lanes up smoke --from <a worktree of the plugins repo or of a plugin's own repo>
curl -skI -H "X-WP-Lane: smoke" https://mysite.local/   # shows X-WP-Lane: smoke
wp-lanes down smoke
```

Never copy `~/.wp-lanes/sites/*.json` between machines: Local gives the same site a different id on
each machine, so the php.ini path and `localSiteId` differ. Run `init-site --domain` on each.

## Known differences on macOS

- **Symlinks instead of junctions.** Lane plugin dirs are symlinks; `down` unlinks each one and
  never descends into it. No admin rights are needed on either platform.
- **php-fpm instead of php-cgi.** Local on macOS runs PHP-FPM with `pm = static` and
  `pm.max_children = 2` (`php-fpm.d/www.conf`), so both platforms queue requests once more than 2
  are in flight (see "Limits").
- **sites.json location.** `~/Library/Application Support/Local/sites.json`. `site.path` there is
  `~/Local Sites/<name>` (with a space) on a fresh Local install, but whatever the site was created
  with otherwise. Discovery uses the value as stored.
- **PHP binary dir.** `.../bin/darwin-arm64/bin/php` (Apple silicon) or `.../bin/darwin/bin/php`
  (Intel). `.../bin/darwin-arm64/php` also exists there, as a directory, so discovery accepts only
  a file at each candidate.
- **WP-CLI.** Expected at
  `/Applications/Local.app/Contents/Resources/extraResources/bin/wp-cli/wp-cli.phar`. If it is
  missing, discovery falls back to `wp` on PATH, which runs with its own PHP and not Local's
  php.ini; Local's `DB_HOST` uses a socket that only Local's php.ini knows, so `wp-lanes wp` may not
  reach the database. Point `wpCli` at Local's phar if that happens.
- **MySQL over a socket.** Local's MySQL on macOS grants root only `@localhost` and runs with
  `skip-name-resolve`, so TCP to `127.0.0.1:<port>` fails with ERROR 1130, and `localhost` without a
  socket path tries `/tmp/mysql.sock` and fails with ERROR 2002. `init-site` reads `socket =` from
  `<Local>/run/<siteId>/conf/mysql/my.cnf` (the same path `wp-config.php` has in
  `DB_HOST 'localhost:<socket>'`) and the tool's `mysql`/`mysqldump` connect with
  `--protocol=socket --socket=<path>`. On Windows the socket line is ignored and the client uses
  `127.0.0.1:<port>`. Either way the password goes in `MYSQL_PWD`, never on the command line.
  `doctor` shows the socket (exists or missing) and, if MySQL does not answer, the client's own
  error line.
- **`.local` lookups.** macOS can route `.local` names to Bonjour, which makes the first request
  slow; Local's hosts-file entry normally prevents it. Local's router must be in "Site Domains" mode
  for `https://<domain>` to resolve; `doctor`'s 200 check catches a mismatch.

## Telling your AI agent to use it

The tool needs no agent integration; `up`, the header and `down` are enough by hand. For an agent to
pick it on its own, add this to the instructions file your tool reads on every session
(`~/.claude/CLAUDE.md` or a file under `~/.claude/rules/` for Claude Code; `AGENTS.md` for most
others), with your own site path:

```
The local site at <site path> is the base every wp-lanes lane links to: never check out, reset or
stash a branch in its wp-content/plugins or any repo nested in it. To test a branch live, make a
git worktree of that repo (git -C <site path>/wp-content/plugins/<plugin> worktree add <path>
<sha-or-branch>), run `wp-lanes up <name> --from <worktree>` (clones the DB), send
`X-WP-Lane: <name>` on every request or use `wp-lanes wp <name> -- <wp-cli args>`, confirm the
X-WP-Lane response header once, and `wp-lanes down <name>` when done. Requests without a selector
(cron, inbound webhooks) hit the base site, and Local gives the site 2 PHP workers.
```

## Uninstall

1. `wp-lanes down <lane>` for every lane `wp-lanes list` shows.
2. Remove the shim from `wp-config.php`: delete everything from the `// BEGIN wp-lanes shim` line
   through the `// END wp-lanes shim` line, and optionally turn the `defined( 'X' ) || define( ... )`
   lines it guarded back into plain `define( ... )`. Or restore `wp-config.php.bak-pre-lanes`, if
   wp-config has not changed since the shim went in.
3. Delete `wp-content/lanes/`.
4. Delete `~/.wp-lanes/` and run `npm unlink -g wp-lanes` (or `npm unlink` in the clone).
