# 0003: The APIs are API Gateway REST APIs

Status: accepted on 2026-11-03.

## Context

Each service exposes an HTTP API to callers: test suites, the spec-driven-test-client library, the other services, and an admin caller for the shipping simulation. Callers must be identified and throttled without building an identity system (ADR 0005). Routes are defined in CDK, and the specs stay free of API Gateway details (ADR 0004).

## Options

- **REST API (API Gateway v1).** Supports API keys and usage plans. Costs more per request than an HTTP API, which is minor at demo volumes.
- **HTTP API (API Gateway v2).** Cheaper and lower latency, with JWT and Lambda authorizers. It does not support API keys or usage plans.
- **HTTP API with a Lambda authorizer that checks keys.** Cheaper requests, but we would write and run our own key store, lookup and throttling.

## Decision

All three services use API Gateway REST APIs. API keys and usage plans work only on REST APIs, and they are what gives the callers identity and limits with no code to maintain.

## Consequences

- Access control comes from the platform (ADR 0005), and handlers stay free of key checking, apart from the admin-only routes.
- Each request costs more than on an HTTP API.
- A REST API can import an OpenAPI document, but that needs `x-amazon-apigateway-*` extensions in the spec. We define routes in CDK instead, so the specs the library consumes stay clean.
- The default integration timeout is 29 seconds, which a resume from a long Aurora pause can approach. AWS allows raising it above 29 seconds only on Regional and private REST APIs, not on edge-optimized ones, and raising it can reduce the Region-level throttle quota ([API Gateway quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table)). The endpoint type is set when `ServiceApi` is built in Phase 1.
- API Gateway answers a missing or invalid key (403) and throttling (429) itself, in its own format. Those responses have to be customized to the shared error shape (ADR 0005).
