/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { BRAILLE_SHIFT_FRAMES } from "../constants";
import type { AuditEvent, Caps } from "../types";

type Tab = "agents" | "tools" | "skills" | "audit";
const PAGE_SIZE = 12;

const tabItems = (
  tab: Tab,
  caps: Caps,
  auditEvents: AuditEvent[],
): Array<{ title: string; detail: string; extra?: string }> => {
  if (tab === "agents") {
    return caps.agents.map((agent) => ({
      title: agent.name,
      detail: agent.description,
      extra: agent.model,
    }));
  }

  if (tab === "tools") {
    return caps.tools.map((tool) => ({
      title: tool.name,
      detail: tool.description,
      extra: tool.source,
    }));
  }

  if (tab === "audit") {
    return auditEvents.map((event) => ({
      title: `${event.status.toUpperCase()} ${event.category}`,
      detail: event.action,
      extra: new Date(event.timestamp).toLocaleTimeString("en", { hour12: false }),
    }));
  }

  return caps.skills.map((skill) => ({ title: skill.name, detail: skill.description }));
};

export function CapabilitiesPane({
  caps,
  auditEvents,
  active,
  loaderFrameIndex,
}: {
  caps: Caps | null;
  auditEvents: AuditEvent[];
  active: boolean;
  loaderFrameIndex: number;
}) {
  const [tab, setTab] = useState<Tab>("agents");
  const [offset, setOffset] = useState(0);

  useInput((ch, key) => {
    if (!active) return;

    if (ch === "1" || ch.toLowerCase() === "a") {
      setTab("agents");
      setOffset(0);
    }
    if (ch === "2" || ch.toLowerCase() === "t") {
      setTab("tools");
      setOffset(0);
    }
    if (ch === "3" || ch.toLowerCase() === "s") {
      setTab("skills");
      setOffset(0);
    }
    if (ch === "4" || ch.toLowerCase() === "u") {
      setTab("audit");
      setOffset(0);
    }

    if (key.leftArrow || ch.toLowerCase() === "h") {
      setTab((current) => {
        if (current === "tools") return "agents";
        if (current === "skills") return "tools";
        if (current === "audit") return "skills";
        return "agents";
      });
      setOffset(0);
    }

    if (key.rightArrow || ch.toLowerCase() === "l") {
      setTab((current) => {
        if (current === "agents") return "tools";
        if (current === "tools") return "skills";
        if (current === "skills") return "audit";
        return "audit";
      });
      setOffset(0);
    }

    if (key.upArrow || ch.toLowerCase() === "k") {
      setOffset((current) => Math.max(0, current - 1));
    }
    if (key.downArrow || ch.toLowerCase() === "j") {
      const itemCount = caps ? tabItems(tab, caps, auditEvents).length : 0;
      const maxOffset = Math.max(0, itemCount - PAGE_SIZE);
      setOffset((current) => Math.min(maxOffset, current + 1));
    }
  });

  const items = caps ? tabItems(tab, caps, auditEvents) : [];
  const visible = items.slice(offset, offset + PAGE_SIZE);
  const frame = BRAILLE_SHIFT_FRAMES[loaderFrameIndex % BRAILLE_SHIFT_FRAMES.length] ?? BRAILLE_SHIFT_FRAMES[0];

  return (
    <Box flexDirection="column" width={36} borderStyle="single" borderColor={active ? "cyan" : "gray"}>
      <Text bold color="cyan">
        Capabilities {active ? "[1/2/3/4 a/t/s/u h/l]" : ""}
      </Text>
      {!caps && <Text color="gray"> {frame} Loading capabilities...</Text>}
      {caps && (
        <>
          <Box>
            <Text color={tab === "agents" ? "cyan" : "gray"}> Agents({caps.agents.length})</Text>
            <Text color={tab === "tools" ? "cyan" : "gray"}> Tools({caps.tools.length})</Text>
            <Text color={tab === "skills" ? "cyan" : "gray"}> Skills({caps.skills.length})</Text>
            <Text color={tab === "audit" ? "cyan" : "gray"}> Audit({auditEvents.length})</Text>
          </Box>
          {offset > 0 && (
            <Text color="gray" dimColor>
              offset {offset} (up/down or j/k)
            </Text>
          )}

          {tab === "skills" && caps.skills.length === 0 ? (
            <Text color="gray"> No skills - add .skill.yaml to ./skills/</Text>
          ) : tab === "audit" && auditEvents.length === 0 ? (
            <Text color="gray"> No audit events available yet</Text>
          ) : (
            visible.map((item) => (
              <Box key={`${tab}:${item.title}`} flexDirection="column" marginBottom={1} marginLeft={1}>
                <Text bold>
                  {item.title}
                  {item.extra ? <Text color="gray"> ({item.extra})</Text> : null}
                </Text>
                <Text color="gray" wrap="wrap">
                  {item.detail.slice(0, 100)}
                </Text>
              </Box>
            ))
          )}
        </>
      )}
    </Box>
  );
}
