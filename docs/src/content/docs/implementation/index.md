---
title: Implementation
description: Architecture, development, integrations, deployment, and verification guides.
---

These guides explain how the [product specification](/specification/) is built
and operated. Product rules live in the specification; proposals and unresolved
decisions live in [Planning](/planning/).

## Architecture and data

- [System architecture](/implementation/system-architecture/): the system map,
  deployment paths, environment boundaries, request handling, and scheduled work.
- [Backend and database](/implementation/backend/): the server stack, database
  ownership, schema, and generated migrations.
- [Privacy implementation review](/implementation/privacy/): current code evidence
  for drafts, account deletion, access, notification data, and cleanup boundaries.

## Workflows and integrations

| Implementation guide                                     | Product specification                          |
| -------------------------------------------------------- | ---------------------------------------------- |
| [Accounts and authentication](/implementation/accounts/) | [Accounts](/specification/accounts/)           |
| [Events and registrations](/implementation/events/)      | [Events](/specification/events/)               |
| [Discord integration](/implementation/discord/)          | [Discord](/specification/discord/)             |
| [Notification delivery](/implementation/notifications/)  | [Notifications](/specification/notifications/) |

## Development and operations

- [Local development](/implementation/development/): run the application, use
  reusable account states, and simulate external integrations.
- [Deployment](/implementation/deployment/): branch previews, production,
  migrations, and configuration.
- [Testing](/implementation/testing/): isolated application test suites and
  browser-test commands.
- [Dashboard administration](/implementation/operations-dashboard/): setup,
  operations, and safeguards for the [Operations dashboard](/dashboard/).
- [Email previews](/implementation/emails/): fictional examples from the real
  message templates.
- [Maintaining these docs](/implementation/docs-site/): the local reader,
  authoring conventions, and editable diagrams.
