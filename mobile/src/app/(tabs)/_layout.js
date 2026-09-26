import React from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { usePlanner } from "../../lib/planner";
import { C } from "../../components/ui";

function icon(name) {
  return function TabIcon({ color, focused }) {
    return <Ionicons name={focused ? name : name + "-outline"} size={24} color={color} />;
  };
}

export default function TabsLayout() {
  const P = usePlanner();
  const toBuy = P.S.data.shopping.filter((it) => !it.checked).length;
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: C.accentDark,
      tabBarInactiveTintColor: C.muted,
      tabBarStyle: { backgroundColor: C.card, borderTopColor: C.border },
      sceneStyle: { backgroundColor: C.bg },
    }}>
      <Tabs.Screen name="index" options={{ title: "This Week", tabBarIcon: icon("calendar") }} />
      <Tabs.Screen name="explore" options={{ title: "Explore", tabBarIcon: icon("compass") }} />
      <Tabs.Screen name="favorites" options={{ title: "Favorites", tabBarIcon: icon("heart") }} />
      <Tabs.Screen name="list" options={{ title: "List", tabBarIcon: icon("cart"), tabBarBadge: toBuy || undefined,
        tabBarBadgeStyle: { backgroundColor: C.accent, fontSize: 11 } }} />
      <Tabs.Screen name="family" options={{ title: "Family", tabBarIcon: icon("people") }} />
    </Tabs>
  );
}
