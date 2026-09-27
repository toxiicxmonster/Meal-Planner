// Opened by mealplanner://import?url=... (for example from an iPhone Shortcut in Safari's Share menu):
// hand the link to the Favorites tab, which imports it.
import { useEffect } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { usePlanner } from "../lib/planner";

export default function ImportLink() {
  const { url } = useLocalSearchParams();
  const P = usePlanner();
  useEffect(() => {
    if (url) P.setPendingImport(String(url));
    router.replace("/favorites");
  }, [url, P]);
  return null;
}
