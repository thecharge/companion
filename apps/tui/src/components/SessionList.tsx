/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { Box, Text, useInput } from "ink";
import React from "react";
import { type Session, SessionMode } from "../types";

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
  });

  return (
    <Box flexDirection="column" width={34} borderStyle="single" borderColor={active ? "cyan" : "gray"}>
      <Text bold color="cyan">
        {" "}
        Sessions {active ? "[n=new d=del up/down]" : ""}
      </Text>
      {sessions.length === 0 && <Text color="gray"> (none) - press n</Text>}
      {sessions.map((session, i) => (
        <Box key={session.id}>
          <Text color={i === idx ? "black" : "white"} backgroundColor={i === idx ? "cyan" : undefined}>
            {" "}
            <Text color={modeColor(session.mode)}>o</Text> {session.title.slice(0, 23).padEnd(23)}
            {String(session.message_count).padStart(3)}
          </Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="gray"> n=new d=del Enter=open</Text>
      </Box>
    </Box>
  );
}
