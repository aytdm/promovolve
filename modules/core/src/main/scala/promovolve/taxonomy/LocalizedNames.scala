package promovolve.taxonomy

import scala.io.Source
import scala.util.Using

/**
 * Loader for the localized display-name companion files that sit next to
 * the English taxonomy TSVs (`3_0_ja.tsv`, `ad_product_taxonomy_2.0_ja.tsv`).
 *
 * Display-only: the English `name` on each taxonomy node remains the
 * canonical vocabulary — it feeds the classifier prompt and all matching.
 * An id missing from a companion file simply falls back to the English
 * name, so partial coverage is safe.
 *
 * Adding a language to a deployment: drop `<base>_<lang>.tsv` next to the
 * English TSV, add the tag to [[langs]], and add the matching `<lang>.go`
 * catalog on the dashboard side. The dashboard's /admin/settings decides
 * which languages are OFFERED; this list is what the build ships.
 *
 * File format: one header line, then `id<TAB>localized name` per row.
 */
private[taxonomy] object LocalizedNames {

  /** Languages with companion name files compiled into this build. */
  val langs: List[String] = List("ja")

  /**
   * Load every compiled-in language for one taxonomy: `basePath` is the
   * English TSV's resource path without extension (e.g.
   * "/iab_content_taxonomy/3_0"); companions are `<basePath>_<lang>.tsv`.
   * A missing companion contributes an empty map — never an error.
   */
  def loadAll(basePath: String): Map[String, Map[String, String]] =
    langs.map(l => l -> load(s"${basePath}_$l.tsv")).toMap

  /** Primary subtag ("ja-JP" → "ja") so callers can pass request tags. */
  def primary(lang: String): String = lang.takeWhile(_ != '-').toLowerCase

  private def load(resourcePath: String): Map[String, String] =
    Option(getClass.getResourceAsStream(resourcePath)) match {
      case Some(is) =>
        Using(Source.fromInputStream(is, "UTF-8")) { source =>
          source
            .getLines()
            .drop(1) // Skip header
            .flatMap { line =>
              val cols = line.split("\t", -1)
              if (cols.length >= 2) {
                val id = cols(0).trim
                val name = cols(1).trim
                if (id.nonEmpty && name.nonEmpty) Some(id -> name) else None
              } else None
            }
            .toMap
        }.getOrElse(Map.empty)

      case None => Map.empty
    }
}
