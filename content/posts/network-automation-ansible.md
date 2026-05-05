---
title: "Network Automation with Ansible: A Practical Starting Point"
date: 2025-09-05
tags: ["automation", "ansible", "python"]
description: "Getting started with Ansible for network automation — without the cargo-culting."
---

Most network automation tutorials start with a playbook that configures a VLAN. That's fine, but it skips the part where you understand *why* Ansible is structured the way it is and when you should reach for something else.

Here's a practical foundation.

## Why Ansible for Networks?

Ansible uses an agentless model — it connects via SSH (or NETCONF, or HTTPS depending on the platform). No agent to install. For network devices, this is almost always the right model.

```yaml
# inventory.yml
all:
  children:
    core:
      hosts:
        core-01:
          ansible_host: 10.0.0.1
          ansible_network_os: cisco.ios.ios
          ansible_connection: network_cli
          ansible_user: admin
```

## A Real Task: Collecting Interface State

```yaml
- name: Gather interface state from core switches
  hosts: core
  gather_facts: false

  tasks:
    - name: Collect interface data
      cisco.ios.ios_facts:
        gather_subset:
          - interfaces

    - name: Show interfaces that are up
      debug:
        msg: "{{ item.key }}: {{ item.value.operstatus }}"
      loop: "{{ ansible_network_resources.interfaces | dict2items }}"
      when: item.value.operstatus == 'up'
```

## Templates with Jinja2

Configuration rendering is where Ansible shines for networks. Keep your logic in inventory/vars, your structure in templates.

```jinja2
{# templates/bgp.j2 #}
router bgp {{ bgp_asn }}
 bgp router-id {{ router_id }}
 bgp log-neighbor-changes
{% for peer in bgp_peers %}
 neighbor {{ peer.ip }} remote-as {{ peer.asn }}
 neighbor {{ peer.ip }} description {{ peer.description }}
{% endfor %}
```

```yaml
# host_vars/core-01.yml
bgp_asn: 65001
router_id: 10.0.0.1
bgp_peers:
  - ip: 10.0.0.2
    asn: 65002
    description: "upstream-1"
```

## When to Use Something Else

Ansible is great for push-based config management. It's not great for:

- **Real-time state queries** — use NAPALM or direct API calls
- **Event-driven response** — use Ansible EDA or a proper event bus
- **Complex diffs with rollback** — look at Nornir + NAPALM

## The Mental Model

Think of Ansible for networks as: *declarative intent → rendered config → pushed to device*. Keep your vars clean, your templates readable, and your playbooks idempotent.
