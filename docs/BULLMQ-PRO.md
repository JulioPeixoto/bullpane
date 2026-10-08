# BullMQ Pro: group actions and group-aware writes

Bullpane reads BullMQ Pro queues out of the box: groups, their status, waiting and
prioritized jobs, concurrency and rate limits. **Writing** to a Pro queue is different,
because core bullmq does not know groups and Bullpane cannot ship BullMQ Pro.

## Why writes need BullMQ Pro's own package

BullMQ Pro has its own scripts for the operations that touch a group. Verified in
`@taskforcesh/bullmq-pro` 7.38.5:

| Operation | BullMQ Pro | Core bullmq on a grouped job |
|---|---|---|
| promote a delayed job | back into its group's list (`promote-9.lua` → `addToGroup`) | into the queue-wide `wait` list: the job runs **outside its group**, with no group concurrency or rate limit, even while the group is paused |
| retry a failed job | back into its group (`retryJob-11.lua`) | into `wait`, outside its group |
| remove a waiting job | removed "from any state or group" (`removeJob-4.lua`) | the hash is deleted and the id stays in the group's list |
| add a job with `opts.group` | into the group | `opts.group` ignored, the job is not grouped |
| drain the queue | `deleteGroups` empties every group's list | the groups' waiting jobs are left behind |
| obliterate | `QueuePro.obliterate` | the group keys are left behind |
| pause, resume, drain one group | `pauseGroup`, `resumeGroup`, `deleteGroup` | do not exist |

BullMQ Pro is a commercial package served from a private registry, so Bullpane does
not bundle it. It is an **optional** dependency that you install next to Bullpane with
your own BullMQ Pro token.

## What Bullpane does in each case

**Without the package** (the default):

- Every read works.
- Writes that core bullmq gets right still work:
  - promote, retry or remove a job **without** a group;
  - remove a grouped job that is delayed, completed or failed (those sit in the queue-wide keys).
- Writes it would get wrong answer `409 bullmq_pro_api_required` with the reason, instead of silently taking jobs out of their group:
  - promote or retry a grouped job;
  - remove a grouped job that is waiting;
  - add a job with `opts.group`;
  - retry all, drain or obliterate a Pro queue.
- The group actions are shown disabled, with a link to this page.

**With the package**:

- On Pro queues, Bullpane uses `QueuePro`, so every job action runs BullMQ Pro's own scripts.
- On the group page, the group actions are enabled: pause, resume and drain.
- Queues that are not Pro keep core bullmq. Pro's scripts follow the bullmq version Pro bundles, not the one your core workers run.

A queue counts as Pro when `meta.version` starts with `bullmq-pro`, or when one of its
group status zsets (or `groups:metas`) exists. A job counts as grouped when its hash has
`gid`, or its `opts.group.id` is set.

The boot banner says which mode is on:

```
  bullmq-pro: 7.38.5 (group actions and group-aware writes on BullMQ Pro queues)
```

## Installing it

Use the BullMQ Pro version your workers run. Bullpane resolves
`@taskforcesh/bullmq-pro` from `BULLMQ_PRO_DIR` when it is set, and otherwise from its
own `node_modules`.

### Docker

Build a small image on top of Bullpane's, passing the token as a build secret so it
does not end up in a layer:

```dockerfile
FROM ghcr.io/madmorett/bullpane:<version>
USER root
WORKDIR /opt/bullmq-pro
RUN --mount=type=secret,id=taskforce_token \
    npm init -y >/dev/null \
 && npm config set @taskforcesh:registry https://npm.taskforce.sh/ \
 && npm config set //npm.taskforce.sh/:_authToken "$(cat /run/secrets/taskforce_token)" \
 && npm install --omit=dev @taskforcesh/bullmq-pro@<your-pro-version> \
 && npm config delete //npm.taskforce.sh/:_authToken \
 && chown -R bullpane:bullpane /opt/bullmq-pro
ENV BULLMQ_PRO_DIR=/opt/bullmq-pro
WORKDIR /app
USER bullpane
```

```bash
docker build --secret id=taskforce_token,env=NPM_TASKFORCESH_TOKEN -t bullpane-pro .
```

### From source or `npx`

Install the package in any folder and point `BULLMQ_PRO_DIR` at it:

```bash
mkdir -p ~/.bullpane/bullmq-pro && cd ~/.bullpane/bullmq-pro && npm init -y >/dev/null
npm install @taskforcesh/bullmq-pro   # with the Taskforce registry and token configured
BULLMQ_PRO_DIR=~/.bullpane/bullmq-pro npx bullpane --redis redis://localhost:6379
```

If the package is found but broken (it does not export `QueuePro`), the boot stops
with that error instead of starting half-configured.
