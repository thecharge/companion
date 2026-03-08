/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { Caps } from "../types";

type Tab = "agents" | "tools" | "skills";

export function CapabilitiesPane({ caps, active }: { caps: Caps | null; active: boolean }) {
  const [tab, setTab] = useState<Tab>("agents");

  useInput((ch) => {
    if (!active) return;
    if (ch === "1") setTab("agents");
    if (ch === "2") setTab("tools");
    if (ch === "3") setTab("skills");
  });

  return (
    <Box flexDirection="column" width={36} borderStyle="single" borderColor={active ? "cyan" : "gray"}>
      <Text bold color="cyan">
        {" "}
        Capabilities {active ? "[1/2/3]" : ""}
      </Text>
      {!caps && <Text color="gray"> Loading...</Text>}
      {caps && (
        <>
          <Box>
            <Text color={tab === "agents" ? "cyan" : "gray"}> Agents({caps.agents.length})</Text>
            <Text color={tab === "tools" ? "cyan" : "gray"}> Tools({caps.tools.length})</Text>
            <Text color={tab === "skills" ? "cyan" : "gray"}> Skills({caps.skills.length})</Text>
          </Box>

          {tab === "agents" &&
            caps.agents.map((agent) => (
              <Box key={agent.name} flexDirection="column" marginBottom={1} marginLeft={1}>
                <Text bold>
                  {agent.name} <Text color="gray">({agent.model})</Text>
                </Text>
                <Text color="gray" wrap="wrap">
                  {" "}
                  {agent.description.slice(0, 100)}
                </Text>
              </Box>
            ))}

          {tab === "tools" &&
            caps.tools.slice(0, 15).map((tool) => (
              <Box key={tool.name} flexDirection="column" marginBottom={1} marginLeft={1}>
                <Text bold>{tool.name}</Text>
                <Text color="gray" wrap="wrap">
                  {" "}
                  {tool.description.slice(0, 80)}
                </Text>
              </Box>
            ))}

          {tab === "skills" &&
            (caps.skills.length === 0 ? (
              <Text color="gray"> No skills - add .skill.yaml to ./skills/</Text>
            ) : (
              caps.skills.map((skill) => (
                <Box key={skill.name} flexDirection="column" marginBottom={1} marginLeft={1}>
                  <Text bold>{skill.name}</Text>
                  <Text color="gray" wrap="wrap">
                    {" "}
                    {skill.description}
                  </Text>
                </Box>
              ))
            ))}
        </>
      )}
    </Box>
  );
}
