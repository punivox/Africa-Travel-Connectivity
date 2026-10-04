# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately by email to [support@safariesim.com](mailto:support@safariesim.com) with "Security" in the subject line. Don't open a public issue.

Include what you found, how to reproduce it, and the impact you expect. We'll acknowledge your report, keep you updated while we fix it, and credit you if you'd like.

## Scope

- The MCP endpoint at `https://api.safariesim.com/functions/v1/mcp`
- The code in this repository

Of particular interest: anything that exposes supplier, partner, customer or internal data through a tool; bypasses of rate limiting; or ways to make the endpoint do work out of proportion to a request.

## Design notes

The server is read-only and holds no customer data. It writes only rate-limit rows, with IP addresses stored as truncated hashes, and partner usage counters. Its database credential exists only in Supabase's function secrets and never appears in this repository.
