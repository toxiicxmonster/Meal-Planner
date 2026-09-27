// Favorites: your meals in Dinner / Lunch / Breakfast / Sides tabs. A meal can be in several.
import React, { useState } from "react";
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { MP, usePlanner } from "../../lib/planner";
import { Button, C, Chip, Empty, MealPhoto, Title, s, tap } from "../../components/ui";
import { EditorSheet, ImportSheet, RecipeSheet } from "../../components/sheets";

export default function FavoritesScreen() {
  const P = usePlanner();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");
  const [recipe, setRecipe] = useState(null);
  const [editing, setEditing] = useState(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const pendingImport = P.S.pendingImport; // a link shared into the app (mealplanner://import?url=...)
  const closeImport = () => { P.takePendingImport(); setImportOpen(false); };
  const all = P.S.data.favorites;
  const count = (k) => all.filter((m) => k === "all" || MP.mealTypes(m).has(k)).length;
  const q = query.toLowerCase().trim();
  const favs = all
    .filter((m) => tab === "all" || MP.mealTypes(m).has(tab))
    .filter((m) => !q || [m.name, m.category, m.notes].join(" ").toLowerCase().includes(q))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const tabName = MP.FAV_TABS.find(([k]) => k === tab)[1];

  const header = (
    <View style={{ marginBottom: 10 }}>
      <Title title={`Favorites${all.length ? ` (${all.length})` : ""}`} subtitle="Tap the tags on a meal to sort it."
        right={<Button small title="Import" icon="download-outline" kind="soft" onPress={() => setImportOpen(true)} />} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {MP.FAV_TABS.map(([k, l]) => <Chip key={k} label={`${l} ${count(k)}`} on={tab === k} onPress={() => setTab(k)} />)}
      </ScrollView>
      <TextInput style={[s.input, { marginTop: 10 }]} value={query} onChangeText={setQuery} placeholder="Filter favorites…"
        placeholderTextColor={C.muted} clearButtonMode="while-editing" autoCorrect={false} />
    </View>
  );

  return (
    <SafeAreaView style={s.screen} edges={["top"]}>
      <FlatList
        data={favs}
        keyExtractor={(m) => m.uid}
        numColumns={2}
        columnWrapperStyle={{ gap: 12 }}
        contentContainerStyle={[s.pad, { gap: 12, paddingBottom: 100 }]}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListEmptyComponent={<Empty text={q ? "No matches." : tab !== "all" && all.length
          ? `No ${tabName.toLowerCase()} favorites yet.\nTap + to add one, or tap a meal's ${tabName} tag in the All tab.`
          : "No favorites yet.\nTap + to add a meal, or Save anything in Explore."} />}
        renderItem={({ item: m }) => {
          const types = MP.mealTypes(m);
          return (
            <View style={[s.card, { flex: 1 }]}>
              <Pressable onPress={() => { tap(); setRecipe(m); }}>
                <MealPhoto meal={m} style={{ width: "100%", aspectRatio: 4 / 3 }} />
              </Pressable>
              <View style={{ padding: 10, gap: 6, flex: 1 }}>
                <Pressable onPress={() => { tap(); setRecipe(m); }}>
                  <Text style={{ fontWeight: "700", color: C.text }} numberOfLines={2}>{m.name}</Text>
                  {m.notes ? <Text style={[s.muted, s.small, { fontStyle: "italic" }]} numberOfLines={2}>{m.notes}</Text> : null}
                </Pressable>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                  {MP.TYPE_TAGS.map(([k, l]) => (
                    <Pressable key={k} onPress={() => { tap(); P.toggleFavType(m.uid, k); }}
                      style={{ borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3,
                        borderColor: types.has(k) ? C.accentSoft : C.border, backgroundColor: types.has(k) ? C.accentSoft : C.card }}>
                      <Text style={{ fontSize: 11, fontWeight: "600", color: types.has(k) ? C.accentDark : C.muted }}>{l}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={{ flex: 1 }} />
                <Pressable onPress={() => { tap(); setEditing({ uid: m.uid }); }} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Ionicons name="create-outline" size={15} color={C.muted} /><Text style={[s.muted, s.small, { fontWeight: "600" }]}>Edit</Text>
                </Pressable>
              </View>
            </View>
          );
        }}
      />
      <Pressable accessibilityLabel="Add a meal" onPress={() => { tap(); setEditing({ uid: null, type: tab !== "all" ? tab : "dinner" }); }}
        style={{ position: "absolute", right: 18, bottom: 18 + insets.bottom * 0, width: 58, height: 58, borderRadius: 29, backgroundColor: C.accent,
          alignItems: "center", justifyContent: "center", shadowColor: C.accent, shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } }}>
        <Ionicons name="add" size={32} color="#fff" />
      </Pressable>
      <RecipeSheet meal={recipe} onClose={() => setRecipe(null)} />
      <EditorSheet target={editing} onClose={() => setEditing(undefined)} />
      <ImportSheet visible={importOpen || !!pendingImport} initialUrl={pendingImport} onClose={closeImport}
        onImported={(draft) => { closeImport(); setEditing({ uid: null, draft }); }} />
    </SafeAreaView>
  );
}
