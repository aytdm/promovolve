package promovolve.taxonomy

import scala.io.Source
import scala.util.Using

/**
 * Loader for the Japanese display-name companion files that sit next to
 * the English taxonomy TSVs (`3_0_ja.tsv`, `ad_product_taxonomy_2.0_ja.tsv`).
 *
 * Display-only: the English `name` on each taxonomy node remains the
 * canonical vocabulary — it feeds the classifier prompt and all matching.
 * A missing id here simply falls back to the English name, so partial
 * coverage is safe.
 *
 * File format: one header line, then `id<TAB>japanese name` per row.
 */
private[taxonomy] object JaNames {
  def load(resourcePath: String): Map[String, String] =
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
