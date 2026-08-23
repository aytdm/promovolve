package promovolve.taxonomy

import org.scalatest.OptionValues
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

class PlacesSpec extends AnyWordSpec with Matchers with OptionValues {

  // Kamakura is the worked example in docs/design/GEOGRAPHIC_CONTEXT.md.
  private val Kamakura = "GN1860672"

  "the tables" should {

    "load all three levels" in {
      Places.size should be > 70000
      Places.get("JP").value.kind shouldBe PlaceKind.Country
      Places.get("JP-13").value.kind shouldBe PlaceKind.Subdivision
      Places.get(Kamakura).value.kind shouldBe PlaceKind.City
    }

    // The build links cities to ISO subdivisions by NAME because GeoNames
    // numbers admin1 its own way: GeoNames JP.13 is Hyogo, ISO JP-13 is
    // Tokyo. Getting this backwards would have resolved every LLM-emitted
    // "JP-13" to the wrong prefecture, silently — so pin the ISO reading.
    "carry ISO 3166-2 subdivision codes, not GeoNames admin1 codes" in {
      Places.get("JP-13").value.name shouldBe "Tokyo"
      Places.get("JP-14").value.name shouldBe "Kanagawa"
      Places.get("JP-26").value.name shouldBe "Kyoto"
      Places.get("JP-28").value.name shouldBe "Hyogo"
    }
  }

  "ancestors" should {

    "walk city to subdivision to country, nearest first" in {
      Places.ancestors(Kamakura).map(_.code) shouldBe List("JP-14", "JP")
    }

    "stop at the country" in {
      Places.ancestors("JP-13").map(_.code) shouldBe List("JP")
      Places.ancestors("JP") shouldBe Nil
    }

    "return nothing for an unknown code" in {
      Places.ancestors("XX-99") shouldBe Nil
      Places.ancestors("") shouldBe Nil
    }
  }

  "expandWithHops" should {

    "keep the minimum hop distance for each place" in {
      Places.expandWithHops(List(Kamakura)) shouldBe Map(Kamakura -> 0, "JP-14" -> 1, "JP" -> 2)
    }

    "prefer a directly named place over the same place reached as an ancestor" in {
      val expanded = Places.expandWithHops(List(Kamakura, "JP"))
      expanded("JP") shouldBe 0
      expanded("JP-14") shouldBe 1
    }

    "drop unknown codes rather than inventing nodes" in {
      Places.expandWithHops(List("XX-99")) shouldBe empty
      Places.expandWithHops(List(Kamakura, "XX-99")).keySet should contain noneOf ("XX-99", "XX")
    }

    "be empty for empty input" in {
      Places.expandWithHops(Nil) shouldBe empty
    }
  }

  "validate" should {

    // The closed-vocabulary gate: an LLM answer or a client-supplied
    // targeting set must never introduce a code the tables do not know.
    "keep known codes and drop everything else" in {
      Places.validate(List("JP", "JP-13", Kamakura, "XX-99", "Tokyo", "")) shouldBe
      Set("JP", "JP-13", Kamakura)
    }
  }

  "localized names" should {

    "resolve Japanese for all three levels" in {
      Places.nameIn("ja", "JP").value shouldBe "日本"
      Places.nameIn("ja", "JP-13").value shouldBe "東京"
      Places.nameIn("ja", Kamakura).value shouldBe "鎌倉"
    }

    "accept a full language tag" in {
      Places.nameIn("ja-JP", "JP-13").value shouldBe "東京"
    }

    "fall back to the English name, then the code" in {
      Places.displayName("en", "JP-13") shouldBe "Tokyo"
      Places.displayName("ja", "XX-99") shouldBe "XX-99"
    }
  }

  // The door the first cut left "cheap to open": a classifier-named city,
  // resolved IN SCOPE. Kanazawa is the live case — a Kanazawa article
  // classified as JP-17 matched no campaign targeting Kanazawa, because the
  // targeting side never expands and the content side could not name the
  // city.
  "resolveCity" should {
    val Kanazawa = "GN1860243"

    "resolve a city inside its subdivision" in {
      Places.resolveCity("Kanazawa", "JP-17").value.code shouldBe Kanazawa
      Places.resolveCity("Kamakura", "JP-14").value.code shouldBe Kamakura
    }

    "resolve inside the country when the name is unique there" in {
      Places.resolveCity("Kamakura", "JP").value.code shouldBe Kamakura
    }

    "refuse to guess between same-named cities in one country" in {
      // Springfield, US: a dozen of them, none dominant.
      Places.resolveCity("Springfield", "US") shouldBe None
    }

    "resolve the dominant one when the largest clearly outweighs the rest" in {
      // Portland, US: Oregon's 650k against Maine's 67k and four townships.
      Places.resolveCity("Portland", "US").value.code shouldBe "GN5746545"
    }

    "pick the most populous inside a subdivision" in {
      Places.resolveCity("Springfield", "US-IL").value.code shouldBe "GN4250542"
    }

    "ignore case, diacritics and accept localized names" in {
      Places.resolveCity("KANAZAWA", "JP-17").value.code shouldBe Kanazawa
      Places.resolveCity("金沢", "JP-17").value.code shouldBe Kanazawa
    }

    // The tables themselves disagree (鎌倉 but 京都市), so both directions
    // must work: a suffix the table lacks is stripped, one it carries is added.
    "tolerate a Japanese municipality suffix either way" in {
      Places.resolveCity("金沢市", "JP-17").value.code shouldBe Kanazawa
      Places.resolveCity("鎌倉市", "JP").value.code shouldBe Kamakura
      Places.resolveCity("京都", "JP").value.code shouldBe "GN1857910"
    }

    "refuse a city outside the stated scope" in {
      Places.resolveCity("Kanazawa", "JP-13") shouldBe None
      Places.resolveCity("Kanazawa", "US") shouldBe None
    }

    "refuse an unknown scope, a city as scope, or a blank name" in {
      Places.resolveCity("Kanazawa", "XX-99") shouldBe None
      Places.resolveCity("Kanazawa", Kamakura) shouldBe None
      Places.resolveCity("   ", "JP-17") shouldBe None
    }
  }

  "resolveEmitted" should {

    "pass a plain code through untouched" in {
      Places.resolveEmitted("JP-17") shouldBe Some("JP-17")
      Places.resolveEmitted(" JP ") shouldBe Some("JP")
    }

    "resolve a 'City, CODE' pair to the city" in {
      Places.resolveEmitted("Kanazawa, JP-17") shouldBe Some("GN1860243")
      Places.resolveEmitted("kanazawa,jp-17") shouldBe Some("GN1860243")
    }

    // Coarser, never wrong: a name the table does not know inside a scope
    // it does keeps the scope.
    "degrade an unresolvable city to its stated scope" in {
      Places.resolveEmitted("Nowhere, JP-17") shouldBe Some("JP-17")
      Places.resolveEmitted("Springfield, US") shouldBe Some("US")
    }

    "drop a pair whose scope is unknown, and blank input" in {
      Places.resolveEmitted("Kanazawa, XX-99") shouldBe None
      Places.resolveEmitted("") shouldBe None
    }
  }

  "search" should {

    "find a city by its English name" in {
      Places.search("kamakura").map(_.code) should contain(Kamakura)
    }

    "find a place by its localized name" in {
      Places.search("鎌倉").map(_.code) should contain(Kamakura)
      Places.search("東京").map(_.code) should contain("JP-13")
    }

    "ignore case and diacritics" in {
      Places.search("HYOGO").map(_.code) should contain("JP-28")
      Places.search("kyoto").map(_.code) should contain("JP-26")
    }

    "find a country by its everyday Japanese name, not only the catalogue's formal one" in {
      // iso-codes says 米国 / 英国; GeoNames' alternate names supply the
      // names people actually type.
      Places.search("アメリカ").headOption.map(_.code) shouldBe Some("US")
      Places.search("イギリス").map(_.code) should contain("GB")
      Places.search("米国").map(_.code) should contain("US")
    }

    "find foreign cities by their Japanese names" in {
      Places.search("ロサンゼルス").map(_.code) should contain("GN5368361")
      Places.search("ロンドン").map(_.code) should contain("GN2643743")
      Places.search("ニューヨーク").map(_.code) should contain("GN5128581")
    }

    "keep kana voicing marks apart: パリ is Paris, not Bali" in {
      val paris = Places.search("パリ").map(_.code)
      paris should contain("GN2988507")
      paris should not contain "ID-BA"
    }

    "tolerate a Japanese administrative suffix on the query" in {
      Places.search("石川県").map(_.code) should contain("JP-17")
      Places.search("豊岡市").map(_.code) should contain("GN1849831")
      Places.search("鎌倉市").map(_.code) should contain(Kamakura)
    }

    "rank broader places above cities on an equal prefix match" in {
      val hits = Places.search("japan").map(_.code)
      hits.headOption.value shouldBe "JP"
    }

    "return nothing for a blank query" in {
      Places.search("") shouldBe Nil
      Places.search("   ") shouldBe Nil
    }

    "respect the limit" in {
      Places.search("san", limit = 5) should have size 5
    }
  }
}
