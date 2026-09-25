"""Build app/foods.json from AFCD Release 3 (FSANZ).

Energy uses "Energy with dietary fibre, equated (kJ)", the basis used on
Australian nutrition labels. kcal = kJ / 4.184.
"""
import json
import re
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
RAW = HERE / "raw"
OUT = HERE.parent / "app" / "foods.json"


SHORT = {
    "Meat, poultry and game products and dishes": "Meat & poultry",
    "Vegetable products and dishes": "Vegetables",
    "Cereals and cereal products": "Grains & cereals",
    "Fruit products and dishes": "Fruit",
    "Fish and seafood products and dishes": "Fish & seafood",
    "Cereal based products and dishes": "Baked goods & cereal dishes",
    "Non-alcoholic beverages": "Drinks",
    "Milk products and dishes": "Dairy",
    "Seed and nut products and dishes": "Nuts & seeds",
    "Savoury sauces and condiments": "Sauces & condiments",
    "Confectionery and cereal/nut/fruit/seed bars": "Confectionery & bars",
    "Dairy & meat substitutes": "Dairy & meat alternatives",
    "Legume and pulse products and dishes": "Legumes",
    "Sugar products and dishes": "Sugar & sweet spreads",
    "Egg products and dishes": "Eggs",
    "Reptiles, amphibia and insects": "Reptiles & insects",
    "Alcoholic beverages": "Alcohol",
}


def col(df, prefix):
    return next(c for c in df.columns if re.sub(r"\s+", " ", c).startswith(prefix))


def main():
    prof = pd.read_excel(RAW / "Nutrient_profiles.xlsx", "All solids & liquids per 100 g", header=2)

    groups = pd.read_excel(RAW / "Food_group_information.xlsx", "Food group information", header=3)
    groups = groups.dropna(subset=["Food group ID"])
    group_names = {int(r["Food group ID"]): str(r["Food group name"]).strip() for _, r in groups.iterrows()}

    kj, prot, fat, fibre = (col(prof, p) for p in ("Energy with dietary fibre", "Protein", "Fat, total", "Total dietary fibre"))
    carb = col(prof, "Available carbohydrate, with sugar alcohols") if any(
        "Available carbohydrate, with sugar alcohols" in re.sub(r"\s+", " ", c) for c in prof.columns
    ) else col(prof, "Available carbohydrate")

    foods = []
    for _, r in prof.iterrows():
        if pd.isna(r[kj]):
            continue
        g = int(str(int(r["Classification"]))[:2])
        n = lambda c: None if pd.isna(r[c]) else round(float(r[c]), 1)
        foods.append({
            "id": r["Public Food Key"],
            "name": str(r["Food Name"]).strip(),
            "group": SHORT.get(group_names.get(g, "Other"), group_names.get(g, "Other")),
            "kcal": round(float(r[kj]) / 4.184 / 100, 2),  # kcal per gram
            "kj": round(float(r[kj]) / 100, 2),            # kJ per gram
            "p": n(prot), "f": n(fat), "c": n(carb), "fb": n(fibre),  # g per 100 g
            "src": "AFCD",
        })

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(foods, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(foods)} foods -> {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
