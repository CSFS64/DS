# v4 vector-map hotfix

This patch removes raster map tiles entirely. Run `scripts/install_vector_map.ps1` once from PowerShell to vendor the vector map files into `data/`, commit them, then deploy normally.

The browser makes no raster tile requests. The map background, neighboring countries and Russian regional boundaries are rendered from local GeoJSON.
