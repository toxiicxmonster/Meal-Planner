// Explore: every TheMealDB recipe, with search, meal type, cuisine and leave-out filters.
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { MP, PAGE_SIZE, usePlanner } from "../../lib/planner";
import { Button, C, Chip, Empty, MealPhoto, Title, s, tap } from "../../components/ui";
import { CuisineSheet, RecipeSheet } from "../../components/sheets";

export default function ExploreScreen() {
  const P = usePlanner();
  const f = P.S.data.filters;
  const [query, setQuery] = useState("");
  const [paging, setPaging] = useState({ key: "", limit: PAGE_SIZE });
  const [recipe, setRecipe] = useState(null);
  const [cuisineOpen, setCuisineOpen] = useState(false);

  useEffect(() => { if (!P.S.catalog.length) P.ensureCatalog(); }, [P]);
  const leaveOut = f.leave_out.join();
  const catalog = P.S.catalog, order = P.S.exploreOrder;
  // Changing any filter starts again from the first page.
  const filterKey = [query, f.type, f.cuisine, leaveOut].join("|");
  // Ask TheMealDB live which recipes use what's typed ("garlic", "chicken breast"), a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => P.searchIngredient(query), 350);
    return () => clearTimeout(t);
  }, [P, query]);
  const hits = P.S.ingredientHits;
  const limit = paging.key === filterKey ? paging.limit : PAGE_SIZE;
  const visible = useMemo(() => P.exploreVisible(query),
    [P, query, f.type, f.cuisine, leaveOut, catalog, order, hits]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!P.S.catalog.length) {
    return (
      <SafeAreaView style={s.screen} edges={["top"]}>
        <View style={s.pad}>
          <Title title="Explore" subtitle="Recipes from TheMealDB. Tap a photo for the full recipe." />
          <Empty text={P.S.catalogFailed ? "Couldn’t reach TheMealDB. Check your connection." : "Loading recipes from TheMealDB…"} />
          {P.S.catalogFailed ? <Button title="Try again" kind="primary" onPress={P.reloadCatalog} /> : <ActivityIndicator color={C.accent} />}
        </View>
      </SafeAreaView>
    );
  }

  const header = (
    <View style={{ marginBottom: 10 }}>
      <Title title="Explore" subtitle="Recipes from TheMealDB. Tap a photo for the full recipe."
        right={<Button small icon="shuffle" kind="soft" title="Shuffle" onPress={P.reshuffleExplore} />} />
      <View style={[s.input, { flexDirection: "row", alignItems: "center", paddingVertical: 0 }]}>
        <Ionicons name="search" size={18} color={C.muted} />
        <TextInput style={{ flex: 1, paddingVertical: 11, paddingHorizontal: 8, fontSize: 16, color: C.text }} value={query} onChangeText={setQuery}
          placeholder="Dish or ingredient, e.g. chicken" placeholderTextColor={C.muted} clearButtonMode="while-editing" returnKeyType="search" autoCorrect={false} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }}>
        {MP.MEAL_TYPES.map(([k, l]) => <Chip key={k} label={l} on={f.type === k} onPress={() => P.setType(k)} />)}
      </ScrollView>
      <Pressable onPress={() => { tap(); setCuisineOpen(true); }} style={[s.input, { flexDirection: "row", alignItems: "center", marginTop: 10 }]}>
        <Ionicons name="earth-outline" size={18} color={C.muted} />
        <Text style={{ flex: 1, marginLeft: 8, fontSize: 16, color: C.text }}>{P.cuisineLabel()}</Text>
        <Ionicons name="chevron-down" size={18} color={C.muted} />
      </Pressable>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }} contentContainerStyle={{ alignItems: "center" }}>
        <Text style={{ fontWeight: "700", color: C.muted, marginRight: 8 }}>Leave out:</Text>
        {MP.PROTEINS.map(([k, l]) => <Chip key={k} label={l} off={f.leave_out.includes(k)} onPress={() => P.toggleLeaveOut(k)} />)}
      </ScrollView>
      <Text style={[s.muted, s.small, { marginTop: 10 }]}>
        {visible.length} recipe{visible.length === 1 ? "" : "s"}{visible.length !== P.S.catalog.length ? " match your filters" : ""}
      </Text>
    </View>
  );

  return (
    <SafeAreaView style={s.screen} edges={["top"]}>
      <FlatList
        data={visible.slice(0, limit)}
        keyExtractor={(m) => m.id}
        numColumns={2}
        columnWrapperStyle={{ gap: 12 }}
        contentContainerStyle={[s.pad, { gap: 12 }]}
        ListHeaderComponent={header}
        ListEmptyComponent={<Empty text={"No recipes match.\nTry another cuisine or meal type, or turn off a Leave out option."} />}
        onEndReached={() => { if (limit < visible.length) setPaging({ key: filterKey, limit: limit + PAGE_SIZE }); }}
        onEndReachedThreshold={0.6}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        renderItem={({ item: m }) => {
          const saved = P.isFavorite(m.name);
          return (
            <Pressable style={[s.card, { flex: 1 }]} onPress={() => { tap(); setRecipe(m); }}>
              <MealPhoto meal={m} style={{ width: "100%", aspectRatio: 4 / 3 }} />
              <View style={{ padding: 10, flex: 1 }}>
                <Text style={{ fontWeight: "700", color: C.text, fontSize: 14 }} numberOfLines={2}>{m.name}</Text>
                <Text style={[s.muted, s.small, { marginTop: 2 }]} numberOfLines={1}>{[m.category, m.area].filter(Boolean).join(" · ")}</Text>
                <View style={{ flex: 1 }} />
                <Button small title={saved ? "Saved" : "Save"} icon={saved ? "heart" : "heart-outline"} kind={saved ? "done" : "soft"}
                  disabled={saved} onPress={() => P.addFavorite(m)} style={{ marginTop: 8 }} />
              </View>
            </Pressable>
          );
        }}
      />
      <RecipeSheet meal={recipe} onClose={() => setRecipe(null)} />
      <CuisineSheet visible={cuisineOpen} onClose={() => setCuisineOpen(false)} />
    </SafeAreaView>
  );
}
