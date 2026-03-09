/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { Box, Text, useInput } from "ink";
import React from "react";
import { type Session, SessionMode } from "../types";

const VISIBLE_SESSIONS = 16;

function modeColor(mode: Session["mode"]): string {
  if (mode === SessionMode.Local) return "green";
  if (mode === SessionMode.Cloud) return "blue";
  return "yellow";
}

export function SessionList({
  sessions,
  idx,
  active,
  onSelect,
}: {
  sessions: Session[];
  idx: number;
  active: boolean;
  onSelect: (i: number) => void;
}) {
  useInput((_ch, key) => {
    if (!active) return;
    if (key.upArrow) onSelect(Math.max(0, idx - 1));
    if (key.downArrow) onSelect(Math.min(sessions.length - 1, idx + 1));
    if (_ch === "k") onSelect(Math.max(0, idx - 1));
    if (_ch === "j") onSelect(Math.min(sessions.length - 1, idx + 1));
    if (key.pageUp) onSelect(Math.max(0, idx - VISIBLE_SESSIONS));
    if (key.pageDown) onSelect(Math.min(sessions.length - 1, idx + VISIBLE_SESSIONS));
  });

  const start = Math.max(0, Math.min(idx - Math.floor(VISIBLE_SESSIONS / 2), sessions.length - VISIBLE_SESSIONS));
  const visibleSessions = sessions.slice(start, start + VISIBLE_SESSIONS);

  return (
    <Box flexDirection="column" width={34} borderStyle="single" borderColor={active ? "cyan" : "gray"}>
      <Text bold color="cyan">
        {" "}
        Sessions {active ? "[n=new d=del up/down]" : ""}
      </Text>
      {sessions.length === 0 && <Text color="gray"> (none) - press n</Text>}
      {start > 0 && <Text color="gray"> ... {start} older</Text>}
      {visibleSessions.map((session, localIndex) => {
        const i = start + localIndex;
        return (
          <Box key={session.id}>
            <Text color={i === idx ? "black" : "white"} backgroundColor={i === idx ? "cyan" : undefined}>
              {" "}
              <Text color={modeColor(session.mode)}>o</Text> {session.title.slice(0, 23).padEnd(23)}
              {String(session.message_count).padStart(3)}
            </Text>
          </Box>
        );
      })}
      {start + VISIBLE_SESSIONS < sessions.length && <Text color="gray"> ... more below</Text>}
      <Box marginTop={1}>
        <Text color="gray"> n=new d=del Enter=open up/down or j/k</Text>
      </Box>
    </Box>
  );
}
