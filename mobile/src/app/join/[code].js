// Opened by an invite link (mealplanner://join/ABCD2345): hand the code to the Family tab.
import { useEffect } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { usePlanner } from "../../lib/planner";

export default function Join() {
  const { code } = useLocalSearchParams();
  const P = usePlanner();
  useEffect(() => {
    P.setPendingInvite(String(code || ""));
    router.replace("/family");
  }, [code, P]);
  return null;
}
