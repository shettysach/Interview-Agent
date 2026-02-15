{
  description = "Python";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    nixpkgs,
  }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {inherit system;};

    python = pkgs.python312;
  in {
    devShells.${system}.default = pkgs.mkShell {
      packages = with pkgs; [
        # Python and package management
        python
        uv
        ruff
        ty

        livekit
        livekit-cli

        bun

        # VA-API for LiveKit media
        libva
      ];

      LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [
        pkgs.libva
      ];

      shellHook = ''
        # Python environment
        unset PYTHONPATH
        export UV_PYTHON_DOWNLOADS=never
        
        # SSL certificates for Python
        export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
        export REQUESTS_CA_BUNDLE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
      '';
    };
  };
}
