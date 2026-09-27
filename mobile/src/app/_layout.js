import React from "react";
import { View } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { usePlanner, usePlannerLifecycle } from "../lib/planner";
import { C, Toast } from "../components/ui";

export default function RootLayout() {
  usePlannerLifecycle();
  const P = usePlanner();
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="join/[code]" options={{ presentation: "modal" }} />
        <Stack.Screen name="import" options={{ presentation: "modal" }} />
      </Stack>
      <Toast message={P.S.toast} />
      <StatusBar style="dark" />
    </View>
  );
}
